import { useEffect, useState } from "react";
import { io } from "socket.io-client";

const socket = io();

export default function App() {

  const [events, setEvents] = useState([]);
  const [institutions, setInstitutions] = useState([]);

  useEffect(() => {

    socket.on("market_events", (data) => {

      setEvents(prev => [...data, ...prev]);

    });

    socket.on("institutional_activity", (data) => {

      setInstitutions(prev => [...data, ...prev]);

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

      {events.map((e,i)=>(
        <div key={i}
          style={{
            background:"#012a5c",
            padding:"15px",
            borderRadius:"8px",
            marginBottom:"15px"
          }}
        >

          <b>{e.company} ({e.code})</b>

          <div>Event Type: {e.type}</div>

          {e.newOrder && (
            <div>Order Value: ₹{e.newOrder} Cr</div>
          )}

          {e.impactPercent && (
            <div>MarketCap Impact: {e.impactPercent}%</div>
          )}

        </div>
      ))}

      <h2 style={{marginTop:"40px"}}>🏦 Institutional Activity</h2>

      {institutions.map((i,k)=>(
        <div key={k}
          style={{
            background:"#013c1b",
            padding:"15px",
            borderRadius:"8px",
            marginBottom:"15px"
          }}
        >

          <b>{i.company}</b>

          <div>Investor: {i.investor}</div>

          <div>Action: {i.action}</div>

          <div>Shares: {i.quantity}</div>

          <div>Value: ₹{i.value.toFixed(2)} Cr</div>

        </div>
      ))}

    </div>

  );

}