import React, { useState, useEffect, useRef } from 'react';

const API_BASE = "http://localhost:8000";

export default function FetchApp() {
  const [documents, setDocuments] = useState([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [selectedDoc, setSelectedDoc] = useState(null);
  const [isGlobalChat, setIsGlobalChat] = useState(false);
  
  // Theme State
  const [themeColor, setThemeColor] = useState('blue');
  
  // AI & Chat States
  const [chatQuestion, setChatQuestion] = useState("");
  const [loading, setLoading] = useState(false);

  // Image Analysis State
  const [selectedImage, setSelectedImage] = useState(null);
  const [imageAnalysis, setImageAnalysis] = useState("");

  // Refs
  const searchInputRef = useRef(null);
  const chatInputRef = useRef(null);
  const summaryRef = useRef(null);
  const galleryRef = useRef(null);
  const fileInputRef = useRef(null);

  useEffect(() => {
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
  }, []);

  const handleFileUpload = async (e) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const formData = new FormData();
    for (let i = 0; i < files.length; i++) {
      formData.append("files", files[i]);
    }

    setLoading(true);
    try {
      const response = await fetch(`${API_BASE}/upload`, {
        method: "POST",
        body: formData,
      });
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
      console.error("Upload error:", err);
      alert("Upload failed. Check backend terminal.");
    } finally {
      setLoading(false);
      if (e.target) e.target.value = "";
    }
  };

  const handleDelete = async (docName, e) => {
    if (e) e.stopPropagation();
    try {
      const response = await fetch(`${API_BASE}/delete/${encodeURIComponent(docName)}`, {
        method: "DELETE",
      });
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

  const handleAskAI = async (e) => {
    e.preventDefault();
    if (!chatQuestion.trim()) return;

    const currentQ = chatQuestion;
    setChatQuestion("");

    const targetDocName = isGlobalChat ? "GLOBAL_ALL" : (selectedDoc ? selectedDoc.name : "");

    // Optimistic temporary update for instant UI feedback
    let tempHistory = selectedDoc?.chatHistory || [];
    if (!isGlobalChat && selectedDoc) {
      tempHistory = [...tempHistory, { q: currentQ, a: "Thinking..." }];
      setSelectedDoc({ ...selectedDoc, chatHistory: tempHistory });
    }

    try {
      const response = await fetch(`${API_BASE}/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: currentQ,
          doc_name: targetDocName,
        }),
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
      console.error("AI chat network error:", err);
      if (!isGlobalChat && selectedDoc) {
        setSelectedDoc(prev => ({ 
          ...prev, 
          chatHistory: prev.chatHistory.map(item => item.q === currentQ ? { ...item, a: "Error: Could not connect to AI server." } : item) 
        }));
      }
    }
  };

  const analyzeImage = async (imgBase64) => {
    setSelectedImage(imgBase64);
    setImageAnalysis("Analyzing image with Gemini AI...");
    try {
      const response = await fetch(`${API_BASE}/analyze-image`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image_data: imgBase64 }),
      });
      const data = await response.json();
      setImageAnalysis(data.summary || "Could not analyze image.");
    } catch (err) {
      setImageAnalysis("Error analyzing image.");
    }
  };

  const getThemeClasses = () => {
    switch(themeColor) {
      case 'emerald': return { primary: 'from-emerald-400 to-teal-500', bgBtn: 'bg-emerald-600 hover:bg-emerald-700', textAccent: 'text-emerald-400', borderActive: 'border-emerald-500 bg-emerald-950/40' };
      case 'violet': return { primary: 'from-violet-400 to-fuchsia-500', bgBtn: 'bg-violet-600 hover:bg-violet-700', textAccent: 'text-violet-400', borderActive: 'border-violet-500 bg-violet-950/40' };
      default: return { primary: 'from-blue-400 to-purple-500', bgBtn: 'bg-blue-600 hover:bg-blue-700', textAccent: 'text-blue-400', borderActive: 'border-blue-500 bg-blue-950/40' };
    }
  };

  const currentTheme = getThemeClasses();

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        
        <input ref={fileInputRef} type="file" multiple accept=".pdf" onChange={handleFileUpload} className="hidden" />

        {/* Header & Theme Switcher */}
        <header className="flex justify-between items-center border-b border-gray-800 pb-4">
          <div>
            <h1 className={`text-2xl font-bold bg-gradient-to-r ${currentTheme.primary} bg-clip-text text-transparent`}>
              PDF Intelligence & Cloud Workspace
            </h1>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-1.5 bg-gray-900 p-1.5 rounded-xl border border-gray-800">
              <button onClick={() => setThemeColor('blue')} className={`w-5 h-5 rounded-full bg-blue-500 ${themeColor === 'blue' ? 'ring-2 ring-white' : ''}`} title="Blue" />
              <button onClick={() => setThemeColor('emerald')} className={`w-5 h-5 rounded-full bg-emerald-500 ${themeColor === 'emerald' ? 'ring-2 ring-white' : ''}`} title="Emerald" />
              <button onClick={() => setThemeColor('violet')} className={`w-5 h-5 rounded-full bg-violet-500 ${themeColor === 'violet' ? 'ring-2 ring-white' : ''}`} title="Violet" />
            </div>

            <button 
              onClick={() => { setIsGlobalChat(true); setSelectedDoc(null); }}
              className={`px-4 py-2 rounded-xl text-xs font-semibold border transition ${isGlobalChat ? 'bg-purple-900 border-purple-500 text-white' : 'bg-gray-900 border-gray-800 text-gray-300'}`}
            >
              🌐 Global Cross-Chat ({documents.length} Docs)
            </button>

            <button onClick={() => fileInputRef.current?.click()} className={`cursor-pointer ${currentTheme.bgBtn} px-5 py-2.5 rounded-xl font-medium transition shadow-lg`}>
              {loading ? "Processing..." : "Upload PDFs"}
            </button>
          </div>
        </header>

        {/* Workspace Actions Banner */}
        <section className="bg-gradient-to-r from-blue-950/40 via-purple-950/40 to-gray-900 border border-blue-900/50 p-4 rounded-2xl shadow-xl">
          <h2 className={`text-xs font-bold uppercase tracking-wider ${currentTheme.textAccent} mb-3`}>⚡ Clickable Workspace Actions</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
            <button onClick={() => searchInputRef.current?.focus()} className="bg-gray-900/90 border border-gray-800 hover:border-purple-500 p-3 rounded-xl flex items-center space-x-2.5 text-left transition hover:scale-[1.02]">
              <span className="text-xl">🔍</span><div><p className="font-semibold text-gray-200">Advanced Search</p><p className="text-[11px] text-gray-400">Jump to search</p></div>
            </button>
            <button onClick={() => summaryRef.current?.scrollIntoView({ behavior: 'smooth' })} className="bg-gray-900/90 border border-gray-800 hover:border-green-500 p-3 rounded-xl flex items-center space-x-2.5 text-left transition hover:scale-[1.02]">
              <span className="text-xl">📊</span><div><p className="font-semibold text-gray-200">Metadata & Summary</p><p className="text-[11px] text-gray-400">View doc stats</p></div>
            </button>
            <button onClick={() => galleryRef.current?.scrollIntoView({ behavior: 'smooth' })} className="bg-gray-900/90 border border-gray-800 hover:border-yellow-500 p-3 rounded-xl flex items-center space-x-2.5 text-left transition hover:scale-[1.02]">
              <span className="text-xl">🖼️</span><div><p className="font-semibold text-gray-200">Extracted Gallery</p><p className="text-[11px] text-gray-400">View photos</p></div>
            </button>
            <button onClick={() => chatInputRef.current?.focus()} className="bg-gray-900/90 border border-gray-800 hover:border-pink-500 p-3 rounded-xl flex items-center space-x-2.5 text-left transition hover:scale-[1.02]">
              <span className="text-xl">🤖</span><div><p className="font-semibold text-gray-200">Ask Gemini AI</p><p className="text-[11px] text-gray-400">Jump to chat</p></div>
            </button>
          </div>
        </section>

        {/* Search Bar */}
        <section className="bg-gray-900 p-4 rounded-2xl border border-gray-800 shadow-xl">
          <form onSubmit={handleSearch} className="flex gap-4">
            <input ref={searchInputRef} type="text" placeholder="Search text across all saved documents..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="flex-1 bg-gray-950 border border-gray-800 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-purple-500" />
            <button type="submit" className="bg-purple-600 hover:bg-purple-700 px-6 py-3 rounded-xl font-medium text-sm transition">Search History</button>
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

        {/* Main Grid */}
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

          {/* Details & Chat Workspace */}
          <div className="bg-gray-900 p-6 rounded-2xl border border-gray-800 shadow-xl lg:col-span-2 flex flex-col justify-between space-y-6">
            {isGlobalChat ? (
              <div className="space-y-6">
                <div className="border-b border-gray-800 pb-4">
                  <h2 className={`text-xl font-bold ${currentTheme.textAccent}`}>🌐 Global Cross-Library Workspace</h2>
                  <p className="text-xs text-gray-400 mt-1">You are querying across all {documents.length} uploaded documents simultaneously.</p>
                </div>
                <div className="bg-gray-950 p-4 rounded-xl border border-gray-800 space-y-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-purple-400">Ask Gemini AI across all documents</h3>
                  <form onSubmit={handleAskAI} className="flex gap-2">
                    <input ref={chatInputRef} type="text" placeholder="Ask anything across your entire library..." value={chatQuestion} onChange={(e) => setChatQuestion(e.target.value)} className="flex-1 bg-gray-900 border border-gray-800 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-purple-500" />
                    <button type="submit" className="bg-purple-600 hover:bg-purple-700 px-5 py-2.5 rounded-xl text-sm font-medium transition">Ask Global</button>
                  </form>
                </div>
              </div>
            ) : selectedDoc ? (
              <div className="space-y-6">
                
                <div ref={summaryRef} className="border-b border-gray-800 pb-4 space-y-4">
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
                    <div><span className="text-gray-500 block">Extracted Images</span><span className="font-semibold text-gray-200">{selectedDoc.imageCount}</span></div>
                  </div>
                </div>

                <div className="bg-gray-950 p-4 rounded-xl border border-gray-800 space-y-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-purple-400">Ask Gemini AI about this document</h3>
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
                    <input ref={chatInputRef} type="text" placeholder="Ask anything specific from this PDF..." value={chatQuestion} onChange={(e) => setChatQuestion(e.target.value)} className="flex-1 bg-gray-900 border border-gray-800 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-purple-500" />
                    <button type="submit" className="bg-purple-600 hover:bg-purple-700 px-5 py-2.5 rounded-xl text-sm font-medium transition">Ask</button>
                  </form>
                </div>

                {selectedDoc.textContent && selectedDoc.textContent.length > 0 && (
                  <div className="bg-gray-950 p-4 rounded-xl border border-gray-800 space-y-3">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400">📖 Page-wise Document Viewer</h3>
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

                {selectedDoc.images && selectedDoc.images.length > 0 && (
                  <div ref={galleryRef} className="space-y-3">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400">Extracted Photos & Diagrams ({selectedDoc.images.length})</h3>
                    <div className="grid grid-cols-4 gap-3 max-h-40 overflow-y-auto pr-1">
                      {selectedDoc.images.map((img, idx) => (
                        <img key={idx} src={img} alt={`Extracted ${idx}`} onClick={() => analyzeImage(img)} className="w-full h-20 object-cover rounded-xl border border-gray-800 cursor-pointer hover:border-blue-500 transition hover:scale-105" title="Click to analyze" />
                      ))}
                    </div>
                    {selectedImage && (
                      <div className="bg-gray-950 p-4 rounded-xl border border-gray-800 space-y-2 mt-2">
                        <div className="flex justify-between items-center"><span className="text-xs font-semibold text-blue-400 uppercase tracking-wider">Image Analysis</span><button onClick={() => setSelectedImage(null)} className="text-gray-500 hover:text-gray-300 text-xs">✕ Close</button></div>
                        <div className="flex gap-4 items-start"><img src={selectedImage} alt="Selected" className="w-24 h-24 object-cover rounded-lg border border-gray-800" /><p className="text-xs text-gray-300 leading-relaxed flex-1">{imageAnalysis}</p></div>
                      </div>
                    )}
                  </div>
                )}

              </div>
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-gray-500 py-32 space-y-2">
                <span className="text-4xl">📄</span>
                <p className="text-sm">Select a document from the left list to view summary, text viewer, and AI chat.</p>
              </div>
            )}
          </div>

        </div>

      </div>
    </div>
  );
}