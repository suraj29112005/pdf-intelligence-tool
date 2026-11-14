import React, { useState, useEffect, useRef } from 'react';

const API_BASE = "https://pdf-intelligence-backend-npl1.onrender.com";

// Client-side image compression helper to speed up API response
const compressImageBeforeSend = (base64Str, maxWidth = 800, maxHeight = 800) => {
  return new Promise((resolve) => {
    const img = new Image();
    img.src = base64Str;
    img.onload = () => {
      let width = img.width;
      let height = img.height;

      if (width > maxWidth || height > maxHeight) {
        if (width > height) {
          height = Math.round((height * maxWidth) / width);
          width = maxWidth;
        } else {
          width = Math.round((width * maxHeight) / height);
          height = maxHeight;
        }
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', 0.75));
    };
  });
};

export default function FetchApp() {
  const [user, setUser] = useState(localStorage.getItem("pdf_user") || null);
  const [authMode, setAuthMode] = useState("login");
  const [authUsername, setAuthUsername] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authError, setAuthError] = useState("");

  const [documents, setDocuments] = useState([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [selectedDoc, setSelectedDoc] = useState(null);
  const [isGlobalChat, setIsGlobalChat] = useState(false);

  const [themeColor, setThemeColor] = useState('blue');
  const [chatQuestion, setChatQuestion] = useState("");
  const [loading, setLoading] = useState(false);

  // Image analysis states
  const [selectedImage, setSelectedImage] = useState(null);
  const [imageQuestion, setImageQuestion] = useState("");
  const [imageAnalysis, setImageAnalysis] = useState("");
  const [imageLoading, setImageLoading] = useState(false);

  const searchInputRef = useRef(null);
  const chatInputRef = useRef(null);
  const fileInputRef = useRef(null);

  useEffect(() => {
    if (user) {
      fetch(`${API_BASE}/documents`)
        .then((res) => res.json())
        .then((data) => {
          if (data && data.data) {
            setDocuments(data.data);
            if (data.data.length > 0 && !selectedDoc) {
              setSelectedDoc(data.data[0]);
            }
          }
        })
        .catch((err) => console.error("Error fetching documents:", err));
    }
  }, [user]);

  // Automatically select the first image by default so the panel is ALWAYS visible
  useEffect(() => {
    if (selectedDoc && selectedDoc.images && selectedDoc.images.length > 0) {
      setSelectedImage(selectedDoc.images[0]);
    } else {
      setSelectedImage(null);
    }
    setImageAnalysis("");
    setImageQuestion("");
  }, [selectedDoc]);

  const handleAuth = async (e) => {
    e.preventDefault();
    setAuthError("");
    const endpoint = authMode === "login" ? "/login" : "/register";
    try {
      const response = await fetch(`${API_BASE}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: authUsername, password: authPassword }),
      });
      const data = await response.json();
      if (response.ok && data.status === "success") {
        if (authMode === "login") {
          setUser(data.username);
          localStorage.setItem("pdf_user", data.username);
        } else {
          alert("Registration successful! Please login.");
          setAuthMode("login");
        }
      } else {
        setAuthError(data.detail || data.message || "Authentication failed.");
      }
    } catch (err) {
      setAuthError("Network error. Make sure backend is running.");
    }
  };

  const handleLogout = () => {
    setUser(null);
    localStorage.removeItem("pdf_user");
  };

  const handleFileUpload = async (e) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const formData = new FormData();
    for (let i = 0; i < files.length; i++) {
      formData.append("files", files[i]);
    }

    setLoading(true);
    try {
      const response = await fetch(`${API_BASE}/upload`, { method: "POST", body: formData });
      const data = await response.json();
      if (data && data.data) {
        const docRes = await fetch(`${API_BASE}/documents`);
        const docData = await docRes.json();
        if (docData && docData.data) {
          setDocuments(docData.data);
          const newlyUploaded = docData.data.find(d => d.name === data.data[0].name) || docData.data[docData.data.length - 1];
          setSelectedDoc(newlyUploaded);
          setIsGlobalChat(false);
        }
      }
    } catch (err) {
      alert("Upload failed. Check backend terminal.");
    } finally {
      setLoading(false);
      if (e.target) e.target.value = "";
    }
  };

  const handleDelete = async (docName, e) => {
    if (e) e.stopPropagation();
    try {
      const response = await fetch(`${API_BASE}/delete/${encodeURIComponent(docName)}`, { method: "DELETE" });
      if (response.ok) {
        setDocuments((prev) => prev.filter((d) => d.name !== docName));
        if (selectedDoc?.name === docName) setSelectedDoc(null);
      }
    } catch (err) {
      console.error("Delete error:", err);
    }
  };

  const handleSearch = async (e) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;
    try {
      const response = await fetch(`${API_BASE}/search?query=${encodeURIComponent(searchQuery)}`);
      const data = await response.json();
      setSearchResults(data.results || []);
    } catch (err) {
      console.error("Search error:", err);
    }
  };

  const handleExportCSV = () => {
    window.open(`${API_BASE}/export/csv?query=${encodeURIComponent(searchQuery)}`, '_blank');
  };

  const handleAskAI = async (e) => {
    e.preventDefault();
    if (!chatQuestion.trim()) return;
    const currentQ = chatQuestion;
    setChatQuestion("");

    const targetDocName = isGlobalChat ? "GLOBAL_ALL" : (selectedDoc ? selectedDoc.name : "");
    let tempHistory = selectedDoc?.chatHistory || [];
    if (!isGlobalChat && selectedDoc) {
      tempHistory = [...tempHistory, { q: currentQ, a: "Thinking..." }];
      setSelectedDoc({ ...selectedDoc, chatHistory: tempHistory });
    }

    try {
      const response = await fetch(`${API_BASE}/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: currentQ, doc_name: targetDocName }),
      });
      const data = await response.json();

      if (!isGlobalChat && selectedDoc && data.history) {
        setSelectedDoc(prev => ({ ...prev, chatHistory: data.history }));
        setDocuments(prev => prev.map(d => d.name === selectedDoc.name ? { ...d, chatHistory: data.history } : d));
      } else if (isGlobalChat) {
        alert("Global AI Answer: " + data.answer);
      } else if (data.answer) {
        const updated = [...(selectedDoc?.chatHistory || []), { q: currentQ, a: data.answer }];
        setSelectedDoc(prev => ({ ...prev, chatHistory: updated }));
      }
    } catch (err) {
      if (!isGlobalChat && selectedDoc) {
        setSelectedDoc(prev => ({ 
          ...prev, 
          chatHistory: prev.chatHistory.map(item => item.q === currentQ ? { ...item, a: "Error connecting to AI." } : item) 
        }));
      }
    }
  };

  const analyzeImage = async (imgBase64, customQ = "") => {
    setImageLoading(true);
    setSelectedImage(imgBase64);
    setImageAnalysis("Analyzing image with Groq Vision AI...");

    try {
      const optimizedImg = await compressImageBeforeSend(imgBase64);

      const response = await fetch(`${API_BASE}/analyze-image`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          image_data: optimizedImg,
          question: customQ,
          doc_name: selectedDoc ? selectedDoc.name : ""
        }),
      });
      const data = await response.json();
      setImageAnalysis(data.summary || "Could not analyze image.");

      if (data.imageDescriptions && selectedDoc) {
        const updatedDoc = { ...selectedDoc, imageDescriptions: data.imageDescriptions };
        setSelectedDoc(updatedDoc);
        setDocuments(prev => prev.map(d => d.name === selectedDoc.name ? updatedDoc : d));
      }
    } catch (err) {
      setImageAnalysis("Error analyzing image.");
    } finally {
      setImageLoading(false);
    }
  };

  const handleImageQuestionSubmit = (e) => {
    e.preventDefault();
    if (!selectedImage) return;
    analyzeImage(selectedImage, imageQuestion);
    setImageQuestion("");
  };

  const getThemeClasses = () => {
    switch(themeColor) {
      case 'emerald': return { primary: 'from-emerald-400 to-teal-500', bgBtn: 'bg-emerald-600 hover:bg-emerald-700', textAccent: 'text-emerald-400', borderActive: 'border-emerald-500 bg-emerald-950/40' };
      case 'violet': return { primary: 'from-violet-400 to-fuchsia-500', bgBtn: 'bg-violet-600 hover:bg-violet-700', textAccent: 'text-violet-400', borderActive: 'border-violet-500 bg-violet-950/40' };
      default: return { primary: 'from-blue-400 to-purple-500', bgBtn: 'bg-blue-600 hover:bg-blue-700', textAccent: 'text-blue-400', borderActive: 'border-blue-500 bg-blue-950/40' };
    }
  };

  const currentTheme = getThemeClasses();

  if (!user) {
    return (
      <div className="min-h-screen bg-gray-950 text-gray-100 flex items-center justify-center p-6">
        <div className="bg-gray-900 border border-gray-800 p-8 rounded-2xl shadow-2xl w-full max-w-md space-y-6">
          <div className="text-center space-y-2">
            <h1 className="text-2xl font-bold bg-gradient-to-r from-blue-400 to-purple-500 bg-clip-text text-transparent">
              PDF Intelligence & Cloud
            </h1>
            <p className="text-xs text-gray-400">Please {authMode === 'login' ? 'login to your account' : 'create a new account'}</p>
          </div>

          {authError && (
            <div className="bg-red-950/50 border border-red-900 text-red-300 p-3 rounded-xl text-xs">
              {authError}
            </div>
          )}

          <form onSubmit={handleAuth} className="space-y-4">
            <div>
              <label className="text-xs text-gray-400 block mb-1">Username</label>
              <input type="text" required value={authUsername} onChange={(e) => setAuthUsername(e.target.value)} className="w-full bg-gray-950 border border-gray-800 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-purple-500" placeholder="Enter username" />
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">Password</label>
              <input type="password" required value={authPassword} onChange={(e) => setAuthPassword(e.target.value)} className="w-full bg-gray-950 border border-gray-800 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-purple-500" placeholder="Enter password" />
            </div>
            <button type="submit" className="w-full bg-purple-600 hover:bg-purple-700 py-3 rounded-xl font-medium text-sm transition shadow-lg">
              {authMode === 'login' ? 'Login' : 'Register'}
            </button>
          </form>

          <div className="text-center">
            <button onClick={() => { setAuthMode(authMode === 'login' ? 'register' : 'login'); setAuthError(""); }} className="text-xs text-purple-400 hover:underline">
              {authMode === 'login' ? "Don't have an account? Register" : "Already have an account? Login"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 p-6">
      <div className="max-w-7xl mx-auto space-y-6">

        <input ref={fileInputRef} type="file" multiple accept=".pdf" onChange={handleFileUpload} className="hidden" />

        {/* Header */}
        <header className="flex justify-between items-center border-b border-gray-800 pb-4">
          <div>
            <h1 className={`text-2xl font-bold bg-gradient-to-r ${currentTheme.primary} bg-clip-text text-transparent`}>
              PDF Intelligence & Cloud Workspace
            </h1>
            <p className="text-xs text-gray-400 mt-0.5">Welcome back, <span className="text-purple-400 font-semibold">{user}</span></p>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-1.5 bg-gray-900 p-1.5 rounded-xl border border-gray-800">
              <button onClick={() => setThemeColor('blue')} className={`w-5 h-5 rounded-full bg-blue-500 ${themeColor === 'blue' ? 'ring-2 ring-white' : ''}`} title="Blue" />
              <button onClick={() => setThemeColor('emerald')} className={`w-5 h-5 rounded-full bg-emerald-500 ${themeColor === 'emerald' ? 'ring-2 ring-white' : ''}`} title="Emerald" />
              <button onClick={() => setThemeColor('violet')} className={`w-5 h-5 rounded-full bg-violet-500 ${themeColor === 'violet' ? 'ring-2 ring-white' : ''}`} title="Violet" />
            </div>

            <button onClick={() => { setIsGlobalChat(true); setSelectedDoc(null); }} className={`px-4 py-2 rounded-xl text-xs font-semibold border transition ${isGlobalChat ? 'bg-purple-900 border-purple-500 text-white' : 'bg-gray-900 border-gray-800 text-gray-300'}`}>
              🌐 Global Cross-Chat ({documents.length} Docs)
            </button>

            <button onClick={() => fileInputRef.current?.click()} className={`cursor-pointer ${currentTheme.bgBtn} px-5 py-2.5 rounded-xl font-medium transition shadow-lg`}>
              {loading ? "Processing..." : "Upload PDFs"}
            </button>

            <button onClick={handleLogout} className="bg-red-950/40 border border-red-900 hover:bg-red-900/50 text-red-300 px-3 py-2 rounded-xl text-xs transition">
              Logout
            </button>
          </div>
        </header>

        {/* Search Bar */}
        <section className="bg-gray-900 p-4 rounded-2xl border border-gray-800 shadow-xl">
          <form onSubmit={handleSearch} className="flex gap-4">
            <input ref={searchInputRef} type="text" placeholder="Search text across all saved documents..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="flex-1 bg-gray-950 border border-gray-800 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-purple-500" />
            <button type="submit" className="bg-purple-600 hover:bg-purple-700 px-6 py-3 rounded-xl font-medium text-sm transition">Search History</button>
            <button type="button" onClick={handleExportCSV} className="bg-emerald-600 hover:bg-emerald-700 px-4 py-3 rounded-xl font-medium text-sm transition" title="Export Search Results to CSV">📥 Export CSV</button>
          </form>
          {searchResults.length > 0 && (
            <div className="mt-4 space-y-2 max-h-60 overflow-y-auto pr-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-purple-400">Search Results ({searchResults.length}):</h3>
              {searchResults.map((res, idx) => (
                <div key={idx} onClick={() => { setIsGlobalChat(false); const found = documents.find(d => d.name === res.docName); if (found) setSelectedDoc(found); }} className="bg-gray-950 p-3 rounded-xl border border-gray-800 text-sm cursor-pointer hover:border-purple-500 transition">
                  <div className="flex justify-between text-xs text-gray-400 mb-1"><span className="text-blue-400 font-semibold">{res.docName}</span><span>Page {res.pageNumber}</span></div>
                  <p className="text-gray-300 text-xs italic">{res.snippet}</p>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Main Workspace Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

          {/* Sidebar */}
          <div className="bg-gray-900 p-4 rounded-2xl border border-gray-800 shadow-xl lg:col-span-1 space-y-4">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-400">Saved Documents ({documents.length})</h2>
            <div className="space-y-2.5 max-h-[600px] overflow-y-auto pr-1">
              {documents.map((doc) => (
                <div key={doc.name} onClick={() => { setIsGlobalChat(false); setSelectedDoc(doc); }} className={`p-3.5 rounded-xl cursor-pointer transition border ${!isGlobalChat && selectedDoc?.name === doc.name ? currentTheme.borderActive : 'bg-gray-950 border-gray-800 hover:border-gray-700'} flex justify-between items-center group`}>
                  <div className="truncate flex-1 pr-2">
                    <p className="font-medium text-sm truncate text-gray-200">{doc.name}</p>
                    <p className="text-xs text-gray-500 mt-0.5">{doc.pages} Pages • {doc.size}</p>
                  </div>
                  <button onClick={(e) => handleDelete(doc.name, e)} className="text-gray-500 hover:text-red-400 text-xs p-1.5 rounded-lg hover:bg-red-950/30 transition opacity-0 group-hover:opacity-100" title="Delete">🗑️</button>
                </div>
              ))}
              {documents.length === 0 && <p className="text-gray-500 text-xs text-center py-12">No documents uploaded yet.</p>}
            </div>
          </div>

          {/* Workspace Details */}
          <div className="bg-gray-900 p-6 rounded-2xl border border-gray-800 shadow-xl lg:col-span-2 flex flex-col justify-between space-y-6">
            {isGlobalChat ? (
              <div className="space-y-6">
                <div className="border-b border-gray-800 pb-4">
                  <h2 className={`text-xl font-bold ${currentTheme.textAccent}`}>🌐 Global Cross-Library Workspace</h2>
                  <p className="text-xs text-gray-400 mt-1">You are querying across all {documents.length} uploaded documents simultaneously.</p>
                </div>
                <div className="bg-gray-950 p-4 rounded-xl border border-gray-800 space-y-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-purple-400">Ask AI across all documents</h3>
                  <form onSubmit={handleAskAI} className="flex gap-2">
                    <input ref={chatInputRef} type="text" placeholder="Ask anything across your entire library..." value={chatQuestion} onChange={(e) => setChatQuestion(e.target.value)} className="flex-1 bg-gray-900 border border-gray-800 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-purple-500" />
                    <button type="submit" className="bg-purple-600 hover:bg-purple-700 px-5 py-2.5 rounded-xl text-sm font-medium transition">Ask Global</button>
                  </form>
                </div>
              </div>
            ) : selectedDoc ? (
              <div className="space-y-6">

                {/* Document Summary & Meta */}
                <div className="border-b border-gray-800 pb-4 space-y-4">
                  <div className="flex justify-between items-start">
                    <h2 className={`text-xl font-bold ${currentTheme.textAccent}`}>{selectedDoc.name}</h2>
                    <div className="flex gap-2">
                      <a href={`${API_BASE}/export/${encodeURIComponent(selectedDoc.name)}`} target="_blank" rel="noreferrer" className="text-xs bg-gray-800 hover:bg-gray-700 px-3 py-1.5 rounded-lg text-gray-200 transition">
                        📥 Export Report
                      </a>
                      {selectedDoc.url && (
                        <a href={selectedDoc.url} target="_blank" rel="noreferrer" className="text-xs bg-gray-800 hover:bg-gray-700 px-3 py-1.5 rounded-lg text-blue-300 transition">
                          View Cloud PDF ↗
                        </a>
                      )}
                    </div>
                  </div>

                  <div className="bg-blue-950/30 p-4 rounded-xl border border-blue-900/50 text-sm text-gray-200 space-y-1">
                    <strong className={`text-xs uppercase tracking-wider ${currentTheme.textAccent} block mb-1`}>🤖 AI Document Summary</strong>
                    <p className="leading-relaxed">{selectedDoc.summary || "No summary available."}</p>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 bg-gray-950 p-3.5 rounded-xl border border-gray-800 text-xs">
                    <div><span className="text-gray-500 block">Total Pages</span><span className="font-semibold text-gray-200">{selectedDoc.pages}</span></div>
                    <div><span className="text-gray-500 block">File Size</span><span className="font-semibold text-gray-200">{selectedDoc.size}</span></div>
                    <div><span className="text-gray-500 block">Word Count</span><span className="font-semibold text-gray-200">{selectedDoc.wordCount}</span></div>
                    <div><span className="text-gray-500 block">Extracted Tables</span><span className="font-semibold text-gray-200">{selectedDoc.tables || 0}</span></div>
                  </div>
                </div>

                {/* AI Document Chat */}
                <div className="bg-gray-950 p-4 rounded-xl border border-gray-800 space-y-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-purple-400">Ask AI about this document</h3>
                  {selectedDoc.chatHistory && selectedDoc.chatHistory.length > 0 && (
                    <div className="space-y-2 max-h-56 overflow-y-auto pr-1 bg-gray-900/80 p-3 rounded-xl border border-gray-800">
                      {selectedDoc.chatHistory.map((item, idx) => (
                        <div key={idx} className="text-xs space-y-1 border-b border-gray-800 pb-2 mb-2 last:border-0">
                          <p className="text-blue-300 font-medium">Q: {item.q}</p>
                          <p className="text-gray-300">A: {item.a}</p>
                        </div>
                      ))}
                    </div>
                  )}
                  <form onSubmit={handleAskAI} className="flex gap-2">
                    <input type="text" placeholder="Ask anything specific from this PDF..." value={chatQuestion} onChange={(e) => setChatQuestion(e.target.value)} className="flex-1 bg-gray-900 border border-gray-800 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-purple-500" />
                    <button type="submit" className="bg-purple-600 hover:bg-purple-700 px-5 py-2.5 rounded-xl text-sm font-medium transition">Ask</button>
                  </form>
                </div>

                {/* Extracted Tables */}
                {selectedDoc.extractedTables && selectedDoc.extractedTables.length > 0 && (
                  <div className="bg-gray-950 p-4 rounded-xl border border-gray-800 space-y-3">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-green-400">📊 Extracted Tables ({selectedDoc.extractedTables.length})</h3>
                    <div className="max-h-60 overflow-y-auto space-y-3 pr-2">
                      {selectedDoc.extractedTables.map((tbl, tIdx) => (
                        <div key={tIdx} className="bg-gray-900 p-3 rounded-xl border border-gray-800 text-xs overflow-x-auto">
                          <p className="font-semibold text-blue-400 mb-2">Page {tbl.page}</p>
                          <table className="w-full text-left border-collapse">
                            <tbody>
                              {tbl.data.map((row, rIdx) => (
                                <tr key={rIdx} className="border-b border-gray-800">
                                  {row.map((cell, cIdx) => (
                                    <td key={cIdx} className="p-1.5 text-gray-300 border-r border-gray-800 last:border-0">{cell}</td>
                                  ))}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Extracted Photos Gallery & Always-Visible Image Analysis Panel */}
                {selectedDoc.images && selectedDoc.images.length > 0 && (
                  <div className="space-y-3">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400">Extracted Photos & Diagrams ({selectedDoc.images.length})</h3>
                    <div className="grid grid-cols-4 gap-3 max-h-40 overflow-y-auto pr-1">
                      {selectedDoc.images.map((img, idx) => (
                        <div key={idx} className="relative group">
                          <img 
                            src={img} 
                            alt={`Extracted ${idx}`} 
                            onClick={() => { setSelectedImage(img); setImageAnalysis(""); setImageQuestion(""); }} 
                            className={`w-full h-20 object-cover rounded-xl border cursor-pointer transition hover:scale-105 ${selectedImage === img ? 'border-blue-500 ring-2 ring-blue-500/50' : 'border-gray-800'}`} 
                            title="Click to select image" 
                          />
                        </div>
                      ))}
                    </div>

                    {/* Image Analysis & Question Panel - ALWAYS VISIBLE */}
                    <div className="bg-gray-950 p-4 rounded-xl border border-gray-800 space-y-3 mt-2">
                      <div className="flex justify-between items-center">
                        <span className="text-xs font-semibold text-blue-400 uppercase tracking-wider">Image Analysis Panel</span>
                        <span className="text-[10px] text-gray-400">Click any image above to select</span>
                      </div>
                      
                      {selectedImage && (
                        <div className="flex gap-4 items-start bg-gray-900/50 p-3 rounded-xl border border-gray-800">
                          <img src={selectedImage} alt="Selected" className="w-24 h-24 object-cover rounded-lg border border-gray-800" />
                          <div className="flex-1 space-y-2">
                            <button 
                              type="button" 
                              onClick={() => analyzeImage(selectedImage, "")} 
                              disabled={imageLoading}
                              className="bg-purple-600 hover:bg-purple-700 disabled:opacity-50 px-4 py-2 rounded-xl text-xs font-medium transition text-white shadow"
                            >
                              {imageLoading ? "Analyzing..." : "🔍 Analyze Selected Image"}
                            </button>

                            {imageAnalysis && (
                              <p className="text-xs text-gray-300 leading-relaxed bg-gray-900 p-3 rounded-xl border border-gray-800">
                                {imageAnalysis}
                              </p>
                            )}
                          </div>
                        </div>
                      )}

                      {/* Question Asking Area for Image */}
                      {selectedImage && (
                        <form onSubmit={handleImageQuestionSubmit} className="flex gap-2 pt-2 border-t border-gray-800">
                          <input 
                            type="text" 
                            placeholder="Ask a specific question about the selected image..." 
                            value={imageQuestion} 
                            onChange={(e) => setImageQuestion(e.target.value)} 
                            className="flex-1 bg-gray-900 border border-gray-800 rounded-xl px-3 py-2 text-xs focus:outline-none focus:border-blue-500 text-gray-200" 
                          />
                          <button 
                            type="submit" 
                            disabled={imageLoading}
                            className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 px-4 py-2 rounded-xl text-xs font-medium transition text-white"
                          >
                            {imageLoading ? "Processing..." : "Ask Image"}
                          </button>
                        </form>
                      )}
                    </div>

                    {/* Saved & Retrieved Image Analyses */}
                    {selectedDoc.imageDescriptions && selectedDoc.imageDescriptions.length > 0 && (
                      <div className="bg-gray-950 p-4 rounded-xl border border-gray-800 space-y-2 mt-3">
                        <h4 className="text-xs font-semibold text-blue-400 uppercase tracking-wider">Saved Image Analyses ({selectedDoc.imageDescriptions.length})</h4>
                        <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                          {selectedDoc.imageDescriptions.map((item, idx) => (
                            <div key={idx} className="bg-gray-900 p-3 rounded-xl border border-gray-800 text-xs space-y-1">
                              <p className="text-blue-300 font-medium">Q: {item.question || "Detailed Analysis"}</p>
                              <p className="text-gray-300 leading-relaxed">A: {item.description}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Page-wise Text / OCR Viewer */}
                {selectedDoc.textContent && selectedDoc.textContent.length > 0 && (
                  <div className="bg-gray-950 p-4 rounded-xl border border-gray-800 space-y-3">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400">📖 Page-wise Document Viewer (OCR & Text)</h3>
                    <div className="max-h-60 overflow-y-auto space-y-2 pr-2">
                      {selectedDoc.textContent.map((pageObj, pIdx) => (
                        <details key={pIdx} className="bg-gray-900 p-3 rounded-xl border border-gray-800 text-xs">
                          <summary className="font-semibold cursor-pointer text-blue-400">Page {pageObj.page}</summary>
                          <p className="text-gray-300 mt-2 whitespace-pre-line leading-relaxed">{pageObj.text}</p>
                        </details>
                      ))}
                    </div>
                  </div>
                )}

              </div>
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-gray-500 py-32 space-y-2">
                <span className="text-4xl">📄</span>
                <p className="text-sm">Select a document from the left list to view summary, tables, and AI chat.</p>
              </div>
            )}
          </div>

        </div>

      </div>
    </div>
  );
}