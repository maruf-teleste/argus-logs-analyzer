"use client";
import { useState } from "react";

export default function TestPage() {
  const [sessionId, setSessionId] = useState("");
  const [answer, setAnswer] = useState("");

  async function createSession() {
    const res = await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Test" }),
    });
    const data = await res.json();
    setSessionId(data.sessionId);
  }

  async function query() {
    const question = (document.getElementById("q") as HTMLInputElement).value;
    const res = await fetch(`/api/sessions/${sessionId}/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question }),
    });
    const data = await res.json();
    setAnswer(data.answer);
  }

  return (
    <div className="p-8">
      <button onClick={createSession} className="bg-blue-500 px-4 py-2 rounded">
        Create Session
      </button>
      <p>Session: {sessionId}</p>

      <input
        id="q"
        placeholder="Ask question..."
        className="border p-2 w-full mt-4"
      />
      <button onClick={query} className="bg-green-500 px-4 py-2 rounded mt-2">
        Query
      </button>

      <pre className="mt-4 bg-gray-100 p-4">{answer}</pre>
    </div>
  );
}
