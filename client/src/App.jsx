import { useEffect, useState } from "react";
import { io } from "socket.io-client";

const socket = io();

export default function App() {

  const [events, setEvents] = useState([]);

  useEffect(() => {

    socket.on("market_events", (data) => {

      setEvents(prev => [...data, ...prev]);

    });

  }, []);

  return (
    <div style={{
      background:"#001b3a",
      minHeight:"100vh",
      color:"white",
      padding:"40px",
      fontFamily:"Arial"
    }}>

      <h1>Market Intelligence Radar</h1>

      <h2 style={{marginTop:"20px"}}>📡 Market Events</h2>

      {events.length === 0 && (
        <p>No market events yet...</p>
      )}

      {events.map((e,i)=>(
        <div
          key={i}
          style={{
            background:"#012a5c",
            padding:"15px",
            borderRadius:"8px",
            marginBottom:"15px"
          }}
        >

          <b>{e.company} ({e.code})</b>

          <div style={{marginTop:"5px"}}>
            Event: {e.type}
          </div>

          {e.orderValueCrore && (
            <div>
              Order Value: ₹{e.orderValueCrore} Cr
            </div>
          )}

          {e.impact && (
            <div>
              Impact: {e.impact}
            </div>
          )}

          <div style={{marginTop:"5px"}}>
            {e.title}
          </div>

        </div>
      ))}

    </div>
  );

}