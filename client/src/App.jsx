import { useEffect, useState } from "react";
import { io } from "socket.io-client";

const socket = io();

export default function App() {

  const [announcements, setAnnouncements] = useState([]);
  const [count, setCount] = useState(0);

  useEffect(() => {

    socket.on("connect", () => {
      console.log("Connected to server");
    });

    socket.on("bse_announcements", (data) => {

      console.log("Announcements received:", data);

      setAnnouncements(data.announcements || []);
      setCount(data.count || 0);

    });

    return () => {
      socket.off("bse_announcements");
    };

  }, []);

  return (
    <div
      style={{
        background: "#001b3a",
        minHeight: "100vh",
        color: "white",
        padding: "40px",
        fontFamily: "Arial"
      }}
    >

      <h1 style={{ marginBottom: "30px" }}>Market Intelligence</h1>

      <h2>Latest BSE Announcements ({count})</h2>

      {announcements.length === 0 && (
        <p style={{ marginTop: "20px" }}>Waiting for announcements...</p>
      )}

      <div style={{ marginTop: "30px" }}>

        {announcements.map((a, i) => (

          <div
            key={i}
            style={{
              background: "#012a5c",
              padding: "15px",
              borderRadius: "8px",
              marginBottom: "15px"
            }}
          >

            <div style={{ fontWeight: "bold", fontSize: "16px" }}>
              {a.company} ({a.code})
            </div>

            <div style={{ marginTop: "5px" }}>
              {a.title}
            </div>

            <div
              style={{
                marginTop: "8px",
                fontSize: "12px",
                opacity: 0.8
              }}
            >
              {a.date}
            </div>

          </div>

        ))}

      </div>

    </div>
  );
}