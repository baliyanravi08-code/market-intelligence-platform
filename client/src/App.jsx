import { useEffect, useState } from "react";
import { io } from "socket.io-client";

const socket = io();

export default function App() {

  const [orders, setOrders] = useState([]);
  const [sectors, setSectors] = useState([]);

  useEffect(() => {

    socket.on("order_book_updates", (data) => {

      setOrders(prev => [...data, ...prev]);

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

      <h2 style={{marginTop:"20px"}}>📦 Order Book Updates</h2>

      {orders.map((o,i)=>(
        <div key={i}
          style={{
            background:"#012a5c",
            padding:"15px",
            borderRadius:"8px",
            marginBottom:"15px"
          }}
        >

          <b>{o.company} ({o.code})</b>

          <div>New Order: ₹{o.newOrder} Cr</div>

          <div>Total Order Book: ₹{o.totalOrderBook} Cr</div>

          {o.impactPercent && (
            <div>MarketCap Impact: {o.impactPercent}%</div>
          )}

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