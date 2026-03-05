import { useEffect, useState } from "react";
import { io } from "socket.io-client";

const socket = io(window.location.origin);

export default function App(){

  const [events,setEvents] = useState([]);
  const [orders,setOrders] = useState([]);
  const [sector,setSector] = useState([]);

  useEffect(()=>{

    socket.on("connect",()=>{
      console.log("Connected to server");
    });

    socket.on("market_events",(data)=>{
      setEvents(prev=>[...data,...prev].slice(0,20));
    });

    socket.on("order_book_update",(data)=>{
      setOrders(prev=>[data,...prev].slice(0,20));
    });

    socket.on("sector_alerts",(data)=>{
      setSector(prev=>[...data,...prev].slice(0,20));
    });

    socket.on("sector_boom",(data)=>{
      setSector(prev=>[data,...prev].slice(0,20));
    });

    return ()=>{

      socket.off("market_events");
      socket.off("order_book_update");
      socket.off("sector_alerts");
      socket.off("sector_boom");

    };

  },[]);

  return(

    <div style={{
      background:"#001b3a",
      minHeight:"100vh",
      width:"100%",
      color:"white",
      padding:"40px",
      fontFamily:"Arial",
      boxSizing:"border-box"
    }}>

      <h1 style={{marginBottom:"30px"}}>
        ⭐ Market Intelligence Dashboard
      </h1>

      <div style={{
        display:"grid",
        gridTemplateColumns:"1fr 1fr 1fr",
        gap:"30px"
      }}>

        {/* MARKET EVENTS */}

        <div>

          <h2>📢 Market Events</h2>

          {events.map((e,i)=>(
            <div key={i} style={{
              background:"#012a5c",
              padding:"12px",
              marginBottom:"10px",
              borderRadius:"6px"
            }}>
              <b>{e.company}</b>
              <div>{e.title}</div>
            </div>
          ))}

        </div>


        {/* ORDER BOOK */}

        <div>

          <h2>📦 Order Book Updates</h2>

          {orders.map((o,i)=>(
            <div key={i} style={{
              background:"#013b7a",
              padding:"12px",
              marginBottom:"10px",
              borderRadius:"6px"
            }}>
              <b>{o.company}</b>
              <div>Total Orders: ₹{o.totalOrderValue} Cr</div>
            </div>
          ))}

        </div>


        {/* SECTOR SIGNALS */}

        <div>

          <h2>🚀 Sector Signals</h2>

          {sector.map((s,i)=>(
            <div key={i} style={{
              background:"#014a96",
              padding:"12px",
              marginBottom:"10px",
              borderRadius:"6px"
            }}>
              <b>{s.sector}</b>
              <div>Orders: {s.orders || s.companies}</div>
              <div>Total Value: ₹{s.value || s.totalValue} Cr</div>
            </div>
          ))}

        </div>

      </div>

    </div>

  );

}