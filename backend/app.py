from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse, StreamingResponse
from pydantic import BaseModel
import pymupdf as fitz
import base64
import io
import os
import sqlite3
import json
import traceback
import threading
import csv
import hashlib
import shutil
from pathlib import Path
import cloudinary
import cloudinary.uploader
import cloudinary.api
from openai import OpenAI
from dotenv import load_dotenv

# ==============================
# OCR CONFIGURATION
# ==============================
try:
    import pytesseract
    from PIL import Image
    WINDOWS_TESSERACT_PATH = (
        r"C:\Program Files\Tesseract-OCR\tesseract.exe"
    )
    if os.path.exists(WINDOWS_TESSERACT_PATH):
        pytesseract.pytesseract.tesseract_cmd = WINDOWS_TESSERACT_PATH
    elif shutil.which("tesseract"):
        pytesseract.pytesseract.tesseract_cmd = shutil.which("tesseract")
    OCR_AVAILABLE = True
except ImportError:
    OCR_AVAILABLE = False
except Exception:
    OCR_AVAILABLE = False

# ==============================
# ENVIRONMENT CONFIGURATION
# ==============================
env_path = Path(__file__).parent / ".env"
load_dotenv(env_path)

groq_api_key = os.getenv("GROQ_API_KEY")

# ==============================
# CLOUDINARY CONFIGURATION
# ==============================
cloudinary.config(
    cloud_name=os.getenv("CLOUDINARY_CLOUD_NAME"),
    api_key=os.getenv("CLOUDINARY_API_KEY"),
    api_secret=os.getenv("CLOUDINARY_API_SECRET")
)

# ==============================
# GROQ CLIENT
# ==============================
client = None
if groq_api_key:
    try:
        client = OpenAI(
            api_key=groq_api_key,
            base_url="https://api.groq.com/openai/v1"
        )
        print("Groq client initialized successfully.")
    except Exception as e:
        print(f"Groq Client Init Error: {e}")

# ==============================
# FASTAPI APP
# ==============================
app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"]
)

DB_FILE = "pdf_database.db"

# ==============================
# IMAGE COMPRESSION HELPER (FOR SPEED)
# ==============================
def compress_image(base64_str, max_size=(800, 800)):
    """Compresses base64 image to reduce payload size and speed up API response."""
    try:
        if not base64_str.startswith("data:image"):
            return base64_str
        header, encoded = base64_str.split(",", 1)
        img_bytes = base64.b64decode(encoded)
        img = Image.open(io.BytesIO(img_bytes))
        img.thumbnail(max_size)
        
        if img.mode in ("RGBA", "P"):
            img = img.convert("RGB")
            
        buffered = io.BytesIO()
        img.save(buffered, format="JPEG", quality=75)
        new_base64 = base64.b64encode(buffered.getvalue()).decode("utf-8")
        return f"data:image/jpeg;base64,{new_base64}"
    except Exception as e:
        print(f"Image compression failed: {e}")
        return base64_str

# ==============================
# AI IMAGE RECOGNITION HELPER
# ==============================
def analyze_image_custom(image_data, user_question=""):
    if not client:
        return "AI recognition unavailable: GROQ_API_KEY not configured."

    # Compress image before sending to Groq Vision API for faster processing
    optimized_image_data = compress_image(image_data)

    if user_question.strip():
        prompt_text = f"Analyze this image and answer this specific question based on the image content: {user_question}"
    else:
        prompt_text = (
            "Analyze this image in detail. Identify visible objects, exact text written on it, "
            "diagrams, charts, and their purpose. Be factual, comprehensive, and concise. "
            "If text is unreadable, say so instead of guessing."
        )

    try:
        response = client.chat.completions.create(
            model=os.getenv("GROQ_VISION_MODEL", "qwen/qwen3.8-27b"),
            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": prompt_text
                        },
                        {
                            "type": "image_url",
                            "image_url": {"url": optimized_image_data}
                        }
                    ]
                }
            ],
            temperature=0.2,
            max_tokens=150  # Reduced max_tokens for faster generation speed
        )
        return response.choices[0].message.content or "No description returned."
    except Exception as e:
        print(f"Image recognition failed: {e}")
        return f"Image recognition failed: {str(e)}"


# ==============================
# DATABASE INITIALIZATION
# ==============================
def init_db():
    conn = sqlite3.connect(DB_FILE, timeout=30.0)
    cursor = conn.cursor()
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS documents (
            name TEXT PRIMARY KEY,
            public_id TEXT,
            url TEXT,
            size TEXT,
            pages INTEGER,
            status TEXT,
            summary TEXT,
            metadata TEXT,
            word_count INTEGER,
            image_count INTEGER,
            text_content TEXT,
            images TEXT,
            tables TEXT,
            chat_history TEXT DEFAULT '[]',
            image_descriptions TEXT DEFAULT '[]'
        )
    ''')

    cursor.execute("PRAGMA table_info(documents)")
    document_columns = [row[1] for row in cursor.fetchall()]
    if "image_descriptions" not in document_columns:
        cursor.execute(
            "ALTER TABLE documents ADD COLUMN image_descriptions TEXT DEFAULT '[]'"
        )

    cursor.execute('''
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE,
            password TEXT
        )
    ''')

    conn.commit()
    conn.close()

init_db()

# ==============================
# PYDANTIC MODELS
# ==============================
class ChatRequest(BaseModel):
    question: str
    doc_name: str = ""

class ImageRequest(BaseModel):
    image_data: str
    question: str = ""
    doc_name: str = ""

class AuthRequest(BaseModel):
    username: str
    password: str

# ==============================
# SUMMARY GENERATION
# ==============================
def generate_summary(text_content):
    all_text = " ".join(
        [p["text"] for p in text_content]
    ).replace('\n', ' ')

    sentences = [
        s.strip()
        for s in all_text.split('.')
        if len(s.strip()) > 10
    ]
    return (
        '. '.join(sentences[:5]) + "..."
        if sentences
        else "Not enough text to summarize."
    )

# ==============================
# CLOUDINARY BACKGROUND UPLOAD
# ==============================
def upload_to_cloudinary_background(
    file_bytes,
    safe_public_id,
    filename
):
    try:
        upload_result = cloudinary.uploader.upload(
            io.BytesIO(file_bytes),
            resource_type="raw",
            folder="pdf_intelligence_app",
            public_id=safe_public_id,
            format="pdf"
        )
        secure_url = upload_result.get("secure_url", "")
        public_id = upload_result.get("public_id", "")

        conn = sqlite3.connect(DB_FILE, timeout=30.0)
        cursor = conn.cursor()
        cursor.execute(
            """
            UPDATE documents
            SET url = ?, public_id = ?
            WHERE name = ?
            """,
            (secure_url, public_id, filename)
        )
        conn.commit()
        conn.close()
    except Exception as ce:
        print(f"Cloudinary background upload failed: {ce}")

# ==============================
# REGISTER
# ==============================
@app.post("/register")
def register_user(req: AuthRequest):
    hashed_password = hashlib.sha256(
        req.password.encode()
    ).hexdigest()
    try:
        conn = sqlite3.connect(DB_FILE, timeout=30.0)
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT INTO users (username, password)
            VALUES (?, ?)
            """,
            (req.username, hashed_password)
        )
        conn.commit()
        conn.close()
        return {
            "status": "success",
            "message": "User registered successfully!"
        }
    except sqlite3.IntegrityError:
        return {
            "status": "error",
            "message": "Username already exists!"
        }
    except Exception as e:
        return {
            "status": "error",
            "message": str(e)
        }

# ==============================
# LOGIN
# ==============================
@app.post("/login")
def login_user(req: AuthRequest):
    hashed_password = hashlib.sha256(
        req.password.encode()
    ).hexdigest()
    conn = sqlite3.connect(DB_FILE, timeout=30.0)
    cursor = conn.cursor()
    cursor.execute(
        """
        SELECT username
        FROM users
        WHERE username = ? AND password = ?
        """,
        (req.username, hashed_password)
    )
    user = cursor.fetchone()
    conn.close()

    if user:
        return {
            "status": "success",
            "message": "Login successful!",
            "username": user[0]
        }
    raise HTTPException(
        status_code=401,
        detail="Invalid username or password"
    )

# ==============================
# PDF UPLOAD + OCR
# ==============================
@app.post("/upload")
async def upload_files(
    files: list[UploadFile] = File(...)
):
    try:
        results = []
        conn = sqlite3.connect(DB_FILE, timeout=30.0)
        cursor = conn.cursor()

        for file in files:
            content = await file.read()
            safe_public_id = Path(
                file.filename
            ).stem.replace(" ", "_")

            doc = fitz.open(
                stream=content,
                filetype="pdf"
            )

            text_content = []
            extracted_images = []
            extracted_tables = []
            word_count = 0

            for page_num in range(len(doc)):
                page = doc[page_num]
                text = page.get_text("text")

                if len(text.strip()) < 20:
                    if OCR_AVAILABLE:
                        try:
                            pix = page.get_pixmap(
                                dpi=300,
                                colorspace=fitz.csRGB,
                                alpha=False
                            )
                            img = Image.open(
                                io.BytesIO(
                                    pix.tobytes("png")
                                )
                            )
                            text = pytesseract.image_to_string(
                                img,
                                lang="eng",
                                config="--psm 3"
                            )
                        except Exception as ocr_error:
                            print(
                                f"OCR failed on page "
                                f"{page_num + 1}: {ocr_error}"
                            )

                word_count += len(text.split())
                text_content.append({
                    "page": page_num + 1,
                    "text": text
                })

                try:
                    tabs = page.find_tables()
                    if tabs.tables:
                        for t in tabs:
                            extracted_tables.append({
                                "page": page_num + 1,
                                "data": t.extract()
                            })
                except Exception:
                    pass

                for img_idx, img in enumerate(
                    page.get_images(full=True)
                ):
                    if img_idx > 5:
                        break
                    try:
                        base_image = doc.extract_image(
                            img[0]
                        )
                        img_base64 = base64.b64encode(
                            base_image["image"]
                        ).decode("utf-8")
                        extracted_images.append(
                            f"data:image/{base_image['ext']};"
                            f"base64,{img_base64}"
                        )
                    except Exception:
                        pass

            summary = generate_summary(text_content)
            size_str = f"{len(content) / (1024 * 1024):.2f} MB"
            pages_count = len(doc)
            raw_meta = doc.metadata if doc.metadata else {}
            safe_metadata = {
                str(k): (
                    v.decode('utf-8', 'ignore')
                    if isinstance(v, bytes)
                    else str(v)
                )
                for k, v in raw_meta.items()
            }

            meta_json = json.dumps(safe_metadata)
            text_json = json.dumps(text_content)
            images_json = json.dumps(extracted_images)
            tables_json = json.dumps(extracted_tables)

            cursor.execute(
                """
                SELECT chat_history, image_descriptions
                FROM documents
                WHERE name = ?
                """,
                (file.filename,)
            )
            existing_row = cursor.fetchone()
            chat_hist_val = (
                existing_row[0]
                if existing_row and existing_row[0]
                else '[]'
            )
            image_desc_val = (
                existing_row[1]
                if existing_row and existing_row[1]
                else '[]'
            )

            cursor.execute('''
                INSERT OR REPLACE INTO documents
                (
                    name,
                    public_id,
                    url,
                    size,
                    pages,
                    status,
                    summary,
                    metadata,
                    word_count,
                    image_count,
                    text_content,
                    images,
                    tables,
                    chat_history,
                    image_descriptions
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ''', (
                file.filename,
                "",
                "",
                size_str,
                pages_count,
                "Completed",
                summary,
                meta_json,
                word_count,
                len(extracted_images),
                text_json,
                images_json,
                tables_json,
                chat_hist_val,
                image_desc_val
            ))

            threading.Thread(
                target=upload_to_cloudinary_background,
                args=(
                    content,
                    safe_public_id,
                    file.filename
                )
            ).start()

            results.append({
                "id": file.filename,
                "name": file.filename,
                "url": "",
                "size": size_str,
                "pages": pages_count,
                "status": "Completed",
                "wordCount": word_count,
                "imageCount": len(extracted_images),
                "metadata": safe_metadata,
                "tables": len(extracted_tables),
                "summary": summary,
                "images": extracted_images,
                "imageDescriptions": json.loads(image_desc_val),
                "chatHistory": json.loads(chat_hist_val),
                "textContent": text_content,
                "extractedTables": extracted_tables
            })

        conn.commit()
        conn.close()
        return {"data": results}
    except Exception as e:
        print("CRITICAL UPLOAD ERROR:")
        traceback.print_exc()
        return {"error": str(e)}

# ==============================
# GET ALL DOCUMENTS
# ==============================
@app.get("/documents")
def get_all_documents():
    conn = sqlite3.connect(DB_FILE, timeout=30.0)
    cursor = conn.cursor()
    cursor.execute("""
        SELECT
            name,
            url,
            size,
            pages,
            summary,
            word_count,
            image_count,
            metadata,
            tables,
            chat_history,
            images,
            text_content,
            image_descriptions
        FROM documents
    """)
    rows = cursor.fetchall()
    conn.close()

    docs = []
    for row in rows:
        tabs_data = json.loads(row[8]) if row[8] else []
        docs.append({
            "id": row[0],
            "name": row[0],
            "url": row[1],
            "size": row[2],
            "pages": row[3],
            "status": "Completed",
            "summary": row[4],
            "wordCount": row[5],
            "imageCount": row[6],
            "metadata": json.loads(row[7]) if row[7] else {},
            "tables": len(tabs_data),
            "chatHistory": json.loads(row[9]) if row[9] else [],
            "images": json.loads(row[10]) if row[10] else [],
            "textContent": json.loads(row[11]) if row[11] else [],
            "imageDescriptions": json.loads(row[12]) if row[12] else [],
            "extractedTables": tabs_data
        })
    return {"data": docs}

# ==============================
# SEARCH DOCUMENTS
# ==============================
@app.get("/search")
def search_documents(
    query: str,
    doc_name: str = "",
    page_num: str = ""
):
    if not query:
        return {"results": []}

    query_words = query.lower().split()
    search_results = []
    conn = sqlite3.connect(DB_FILE, timeout=30.0)
    cursor = conn.cursor()
    cursor.execute("SELECT name, text_content FROM documents")
    rows = cursor.fetchall()
    conn.close()

    for row in rows:
        name, text_json = row
        if doc_name and doc_name.lower() not in name.lower():
            continue

        text_content = json.loads(text_json)
        for page_data in text_content:
            if page_num and str(page_data["page"]) != page_num:
                continue

            page_text_lower = page_data["text"].lower()
            if all(word in page_text_lower for word in query_words):
                text = page_data["text"]
                idx = text.lower().find(query_words[0])
                snippet = text[
                    max(0, idx - 60):
                    min(len(text), idx + len(query) + 60)
                ].replace('\n', ' ')
                search_results.append({
                    "docName": name,
                    "pageNumber": page_data["page"],
                    "snippet": f"...{snippet}..."
                })
    return {"results": search_results}

# ==============================
# EXPORT SEARCH RESULTS AS CSV
# ==============================
@app.get("/export/csv")
def export_csv(query: str = ""):
    conn = sqlite3.connect(DB_FILE, timeout=30.0)
    cursor = conn.cursor()
    cursor.execute("SELECT name, text_content FROM documents")
    rows = cursor.fetchall()
    conn.close()

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["Document Name", "Page Number", "Matching Snippet"])

    for name, text_json in rows:
        text_content = json.loads(text_json)
        for page in text_content:
            if not query or query.lower() in page["text"].lower():
                snippet = page["text"].replace('\n', ' ')[:150]
                writer.writerow([name, page["page"], snippet])

    output.seek(0)
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={
            "Content-Disposition": "attachment; filename=pdf_search_export.csv"
        }
    )

# ==============================
# DELETE DOCUMENT
# ==============================
@app.delete("/delete/{doc_name}")
def delete_document(doc_name: str):
    conn = sqlite3.connect(DB_FILE, timeout=30.0)
    cursor = conn.cursor()
    cursor.execute("SELECT public_id FROM documents WHERE name = ?", (doc_name,))
    row = cursor.fetchone()
    if row and row[0]:
        try:
            cloudinary.uploader.destroy(row[0], resource_type="raw")
        except Exception:
            pass

    cursor.execute("DELETE FROM documents WHERE name = ?", (doc_name,))
    conn.commit()
    conn.close()
    return {"message": "Deleted successfully"}

# ==============================
# GROQ GPT CHAT ENDPOINT
# ==============================
@app.post("/ask")
def ask_question(req: ChatRequest):
    if not client:
        err_msg = "AI Error: GROQ_API_KEY not found in .env file."
        return {
            "answer": err_msg,
            "history": [{"q": req.question, "a": err_msg}]
        }

    context = ""
    conn = sqlite3.connect(DB_FILE, timeout=30.0)
    cursor = conn.cursor()
    existing_chat = []

    if req.doc_name and req.doc_name != "GLOBAL_ALL":
        cursor.execute(
            "SELECT text_content, chat_history FROM documents WHERE name LIKE ?",
            (f"%{req.doc_name}%",)
        )
        row = cursor.fetchone()
        if row:
            text_content = json.loads(row[0])
            context = " ".join([p["text"] for p in text_content])[:1500]
            existing_chat = json.loads(row[1]) if row[1] else []
    else:
        cursor.execute("SELECT text_content FROM documents")
        rows = cursor.fetchall()
        all_texts = []
        for r in rows:
            tc = json.loads(r[0])
            all_texts.append(" ".join([p["text"] for p in tc][:2]))
        context = " ".join(all_texts)[:2000]

    try:
        response = client.chat.completions.create(
            model="openai/gpt-oss-120b",
            messages=[
                {
                    "role": "system",
                    "content": f"Context: {context if context else 'General'}\nAnswer briefly and directly based on context."
                },
                {
                    "role": "user",
                    "content": req.question
                }
            ],
            temperature=0.3,
            max_tokens=300
        )
        answer = response.choices[0].message.content
        existing_chat.append({"q": req.question, "a": answer})

        if req.doc_name and req.doc_name != "GLOBAL_ALL":
            cursor.execute(
                "UPDATE documents SET chat_history = ? WHERE name = ?",
                (json.dumps(existing_chat), req.doc_name)
            )
            conn.commit()
        conn.close()

        return {"answer": answer, "history": existing_chat}
    except Exception as e:
        conn.close()
        error_msg = f"AI Error: {str(e)}"
        existing_chat.append({"q": req.question, "a": error_msg})
        return {"answer": error_msg, "history": existing_chat}

# ==============================
# EXPORT CHAT HISTORY
# ==============================
@app.get("/export/{doc_name}", response_class=PlainTextResponse)
def export_chat(doc_name: str):
    conn = sqlite3.connect(DB_FILE, timeout=30.0)
    cursor = conn.cursor()
    cursor.execute("SELECT summary, chat_history FROM documents WHERE name = ?", (doc_name,))
    row = cursor.fetchone()
    conn.close()

    if not row:
        return "Document not found."

    summary, chat_json = row
    chats = json.loads(chat_json) if chat_json else []
    report = f"=== DOCUMENT REPORT: {doc_name} ===\n\n[AI SUMMARY]:\n{summary}\n\n[CHAT HISTORY]:\n"
    for idx, c in enumerate(chats, 1):
        report += f"\nQ{idx}: {c['q']}\nA{idx}: {c['a']}\n" + "-" * 40
    return report

# ==============================
# GROQ VISION IMAGE ANALYSIS WITH SAVING & RETRIEVAL
# ==============================
@app.post("/analyze-image")
def analyze_img(req: ImageRequest):
    if not client:
        return {"summary": "AI Error: GROQ_API_KEY not found.", "imageDescriptions": []}

    summary = analyze_image_custom(req.image_data, req.question)
    image_descs = []

    if req.doc_name and req.doc_name != "GLOBAL_ALL":
        try:
            conn = sqlite3.connect(DB_FILE, timeout=30.0)
            cursor = conn.cursor()
            cursor.execute("SELECT image_descriptions FROM documents WHERE name = ?", (req.doc_name,))
            row = cursor.fetchone()
            
            if row:
                image_descs = json.loads(row[0]) if row[0] else []
                image_descs.append({
                    "question": req.question if req.question else "Detailed Analysis",
                    "description": summary
                })
                cursor.execute(
                    "UPDATE documents SET image_descriptions = ? WHERE name = ?",
                    (json.dumps(image_descs), req.doc_name)
                )
                conn.commit()
            conn.close()
        except Exception as e:
            print(f"Failed to save image analysis to database: {e}")

    return {"summary": summary, "imageDescriptions": image_descs}