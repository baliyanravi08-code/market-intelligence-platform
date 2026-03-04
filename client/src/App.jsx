import { useEffect, useState } from "react";
import { io } from "socket.io-client";

const socket = io();

export default function App() {

  const [alerts, setAlerts] = useState([]);

  useEffect(() => {

    socket.on("order_alerts", (data) => {

      setAlerts(prev => [...data, ...prev]);

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

      <h2 style={{marginTop:"20px"}}>🚨 Orders ≥ ₹1 Crore</h2>

      {alerts.length === 0 && (
        <p>No large orders detected yet...</p>
      )}

      {alerts.map((a,i)=>(
        <div
          key={i}
          style={{
            background:"#012a5c",
            padding:"15px",
            borderRadius:"8px",
            marginBottom:"15px"
          }}
        >

          <b>{a.company} ({a.code})</b>

          <div style={{marginTop:"5px"}}>
            Order Value: ₹{a.orderValueCrore} Cr
          </div>

          <div>
            Impact Level: {a.impact}
          </div>

          <div style={{marginTop:"5px"}}>
            {a.title}
          </div>

        </div>
      ))}

    </div>

  );

}