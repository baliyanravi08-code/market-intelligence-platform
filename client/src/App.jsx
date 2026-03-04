import { useEffect, useState } from "react";
import { io } from "socket.io-client";

const socket = io();

export default function App() {

  const [events, setEvents] = useState([]);
  const [sectors, setSectors] = useState([]);

  useEffect(() => {

    socket.on("market_events", (data) => {

      setEvents(prev => [...data, ...prev]);

    });

    socket.on("sector_alerts", (data) => {

      setSectors(prev => [...data, ...prev]);

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
            <div>New Order: ₹{e.newOrder} Cr</div>
          )}

          {e.totalOrderBook && (
            <div>Total Order Book: ₹{e.totalOrderBook} Cr</div>
          )}

          {e.impactPercent && (
            <div>MarketCap Impact: {e.impactPercent}%</div>
          )}

          <div style={{marginTop:"5px"}}>
            {e.title}
          </div>

        </div>
      ))}

      <h2 style={{marginTop:"40px"}}>🚨 Sector Momentum</h2>

      {sectors.map((s,i)=>(
        <div key={i}
          style={{
            background:"#5c2a01",
            padding:"15px",
            borderRadius:"8px",
            marginBottom:"15px"
          }}
        >

          <b>Sector: {s.sector}</b>

          <div>Orders: {s.orders}</div>

          <div>Total Value: ₹{s.value} Cr</div>

        </div>
      ))}

    </div>

  );

}