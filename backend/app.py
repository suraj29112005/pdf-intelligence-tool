from fastapi import FastAPI, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel
import pymupdf as fitz
import base64
import io
import os
import sqlite3
import json
import traceback
import threading
from pathlib import Path

# --- CLOUDINARY CONFIG ---
import cloudinary
import cloudinary.uploader
import cloudinary.api

# --- OPENAI SDK (Compatible with Groq API) ---
from openai import OpenAI
from dotenv import load_dotenv

env_path = Path(__file__).parent / ".env"
load_dotenv(env_path)

# Retrieve Groq API key instead of Gemini
groq_api_key = os.getenv("GROQ_API_KEY")

cloudinary.config(
    cloud_name = os.getenv("CLOUDINARY_CLOUD_NAME"),
    api_key = os.getenv("CLOUDINARY_API_KEY"),
    api_secret = os.getenv("CLOUDINARY_API_SECRET")
)

# Initialize Groq client using OpenAI SDK base_url compatibility
client = None
if groq_api_key:
    try:
        client = OpenAI(
            api_key=groq_api_key,
            base_url="https://api.groq.com/openai/v1"
        )
    except Exception as e:
        print(f"⚠️ Groq Client Init Error: {e}")

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

DB_FILE = "pdf_database.db"

def init_db():
    conn = sqlite3.connect(DB_FILE, timeout=30.0)
    cursor = conn.cursor()
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='documents'")
    table_exists = cursor.fetchone()
    
    if table_exists:
        try:
            cursor.execute("SELECT chat_history FROM documents LIMIT 1")
        except sqlite3.OperationalError:
            cursor.execute("DROP TABLE documents")
            
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
            chat_history TEXT DEFAULT '[]'
        )
    ''')
    conn.commit()
    conn.close()

init_db()

class ChatRequest(BaseModel):
    question: str
    doc_name: str = ""

class ImageRequest(BaseModel):
    image_data: str

def generate_summary(text_content):
    all_text = " ".join([p["text"] for p in text_content]).replace('\n', ' ')
    sentences = [s.strip() for s in all_text.split('.') if len(s.strip()) > 10]
    return '. '.join(sentences[:5]) + "..." if sentences else "Not enough text to summarize."

# Background thread helper for non-blocking Cloudinary upload
def upload_to_cloudinary_background(file_bytes, safe_public_id, filename):
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
        cursor.execute("UPDATE documents SET url = ?, public_id = ? WHERE name = ?", (secure_url, public_id, filename))
        conn.commit()
        conn.close()
        print(f"☁️ Cloudinary background upload completed for: {filename}")
    except Exception as ce:
        print(f"⚠️ Cloudinary background upload skipped/failed: {ce}")

@app.post("/upload")
async def upload_files(files: list[UploadFile] = File(...)):
    try:
        results = []
        conn = sqlite3.connect(DB_FILE, timeout=30.0)
        cursor = conn.cursor()

        for file in files:
            content = await file.read()
            safe_public_id = Path(file.filename).stem.replace(" ", "_")
            
            doc = fitz.open(stream=content, filetype="pdf")
            text_content = []
            extracted_images = []
            word_count = 0
            
            for page_num in range(len(doc)):
                page = doc[page_num]
                text = page.get_text("text")
                word_count += len(text.split())
                text_content.append({"page": page_num + 1, "text": text})
                
                for img_idx, img in enumerate(page.get_images(full=True)):
                    if img_idx > 1: break
                    try:
                        base_image = doc.extract_image(img[0])
                        img_base64 = base64.b64encode(base_image["image"]).decode("utf-8")
                        extracted_images.append(f"data:image/{base_image['ext']};base64,{img_base64}")
                    except Exception:
                        pass
            
            summary = generate_summary(text_content)
            size_str = f"{len(content) / (1024*1024):.2f} MB"
            pages_count = len(doc)
            
            raw_meta = doc.metadata if doc.metadata else {}
            safe_metadata = {str(k): (v.decode('utf-8', 'ignore') if isinstance(v, bytes) else str(v)) for k, v in raw_meta.items()}
            
            meta_json = json.dumps(safe_metadata)
            text_json = json.dumps(text_content)
            images_json = json.dumps(extracted_images)
            tables_json = json.dumps([])

            cursor.execute("SELECT chat_history FROM documents WHERE name = ?", (file.filename,))
            existing_row = cursor.fetchone()
            chat_hist_val = existing_row[0] if existing_row and existing_row[0] else '[]'

            cursor.execute('''
                INSERT OR REPLACE INTO documents 
                (name, public_id, url, size, pages, status, summary, metadata, word_count, image_count, text_content, images, tables, chat_history)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ''', (file.filename, "", "", size_str, pages_count, "Completed", summary, meta_json, word_count, len(extracted_images), text_json, images_json, tables_json, chat_hist_val))
            
            threading.Thread(target=upload_to_cloudinary_background, args=(content, safe_public_id, file.filename)).start()

            results.append({
                "id": file.filename, "name": file.filename, "url": "", "size": size_str,
                "pages": pages_count, "status": "Completed",
                "wordCount": word_count, "imageCount": len(extracted_images),
                "metadata": safe_metadata, "tables": 0, 
                "summary": summary, "images": extracted_images,
                "chatHistory": json.loads(chat_hist_val),
                "textContent": text_content
            })

        conn.commit()
        conn.close()
        return {"data": results}
        
    except Exception as e:
        print("❌ CRITICAL UPLOAD ERROR:")
        traceback.print_exc()
        return {"error": str(e)}

@app.get("/documents")
def get_all_documents():
    conn = sqlite3.connect(DB_FILE, timeout=30.0)
    cursor = conn.cursor()
    cursor.execute("SELECT name, url, size, pages, summary, word_count, image_count, metadata, tables, chat_history, images, text_content FROM documents")
    rows = cursor.fetchall()
    conn.close()

    docs = []
    for row in rows:
        docs.append({
            "id": row[0], "name": row[0], "url": row[1], "size": row[2],
            "pages": row[3], "status": "Completed", "summary": row[4],
            "wordCount": row[5], "imageCount": row[6], "metadata": json.loads(row[7]) if row[7] else {},
            "tables": 0,
            "chatHistory": json.loads(row[9]) if row[9] else [],
            "images": json.loads(row[10]) if row[10] else [],
            "textContent": json.loads(row[11]) if row[11] else []
        })
    return {"data": docs}

@app.get("/search")
def search_documents(query: str, doc_name: str = "", page_num: str = ""):
    if not query: return {"results": []}
    query_words = query.lower().split()
    search_results = []
    
    conn = sqlite3.connect(DB_FILE, timeout=30.0)
    cursor = conn.cursor()
    cursor.execute("SELECT name, text_content FROM documents")
    rows = cursor.fetchall()
    conn.close()

    for row in rows:
        name, text_json = row
        if doc_name and doc_name.lower() not in name.lower(): continue
        text_content = json.loads(text_json)

        for page_data in text_content:
            if page_num and str(page_data["page"]) != page_num: continue
            page_text_lower = page_data["text"].lower()
            if all(word in page_text_lower for word in query_words):
                text = page_data["text"]
                idx = text.lower().find(query_words[0])
                snippet = text[max(0, idx - 60):min(len(text), idx + len(query) + 60)].replace('\n', ' ')
                search_results.append({
                    "docName": name, "pageNumber": page_data["page"], "snippet": f"...{snippet}..."
                })
    return {"results": search_results}

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

@app.post("/ask")
def ask_question(req: ChatRequest):
    print(f"📥 Received Question: {req.question} for doc: {req.doc_name}")
    
    if not client:
        print("❌ Error: Groq Client not initialized!")
        err_msg = "❌ AI Error: GROQ_API_KEY not found in .env file."
        return {"answer": err_msg, "history": [{"q": req.question, "a": err_msg}]}
        
    context = ""
    conn = sqlite3.connect(DB_FILE, timeout=30.0)
    cursor = conn.cursor()
    
    existing_chat = []
    if req.doc_name and req.doc_name != "GLOBAL_ALL":
        cursor.execute("SELECT text_content, chat_history FROM documents WHERE name LIKE ?", (f"%{req.doc_name}%",))
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
        print("🚀 Sending request to Groq API...")
        # Using OpenAI-compatible chat completions interface for Groq with Llama 3.3 70B
        response = client.chat.completions.create(
            model="openai/gpt-oss-120b",
            messages=[
                {"role": "system", "content": f"Context: {context if context else 'General'}\nAnswer briefly and directly based on context."},
                {"role": "user", "content": req.question}
            ],
            temperature=0.3,
            max_tokens=300
        )
        print("✅ Received response from Groq!")
        answer = response.choices[0].message.content
        
        existing_chat.append({"q": req.question, "a": answer})
        
        if req.doc_name and req.doc_name != "GLOBAL_ALL":
            cursor.execute("UPDATE documents SET chat_history = ? WHERE name = ?", (json.dumps(existing_chat), req.doc_name))
            conn.commit()
            
        conn.close()
        return {"answer": answer, "history": existing_chat}
    except Exception as e:
        conn.close()
        print(f"❌ AI ASK ERROR EXCEPTION: {e}")
        error_msg = f"AI Error: {str(e)}"
        existing_chat.append({"q": req.question, "a": error_msg})
        return {"answer": error_msg, "history": existing_chat}

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
        report += f"\nQ{idx}: {c['q']}\nA{idx}: {c['a']}\n{'-'*40}"
    return report

@app.post("/analyze-image")
def analyze_img(req: ImageRequest):
    if not client:
        return {"summary": "AI Error: API key not found."}
    try:
        # Note: For multimodal requests with Groq, pass the image url/base64 if supported by the model, 
        # or fallback to textual description if pure text model. Using llama-3.2-11b-vision-preview or similar if needed.
        response = client.chat.completions.create(
            model="openai/gpt-oss-120b",
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "Describe this image in 2 crisp sentences."},
                        {"type": "image_url", "image_url": {"url": req.image_data}}
                    ]
                }
            ],
            max_tokens=150
        )
        return {"summary": response.choices[0].message.content}
    except Exception as e:
        return {"summary": f"Could not analyze image. Error: {str(e)}"}