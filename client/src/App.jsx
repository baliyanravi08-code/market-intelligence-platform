import { useEffect, useState } from "react";
import { io } from "socket.io-client";

const socket = io();

export default function App() {

  const [announcements, setAnnouncements] = useState([]);

  useEffect(() => {

    socket.on("connect", () => {
      console.log("Connected to server");
    });

    socket.on("bse_announcements", (data) => {
      console.log("Announcements received:", data);

      setAnnouncements(data.announcements || []);
    });

  }, []);

  return (
    <div style={{
      background:"#001b3a",
      minHeight:"100vh",
      color:"white",
      padding:"40px"
    }}>

      <h1>Market Intelligence</h1>

      <h2 style={{marginTop:"30px"}}>Latest BSE Announcements</h2>

      {announcements.length === 0 && (
        <p>No announcements yet...</p>
      )}

      <ul>
        {announcements.map((a, i) => (
          <li key={i} style={{marginBottom:"10px"}}>
            {a}
          </li>
        ))}
      </ul>

    </div>
  );
}