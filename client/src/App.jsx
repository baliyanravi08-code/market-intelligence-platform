import { useEffect,useState } from "react";
import { io } from "socket.io-client";
import "./App.css";

const socket = io(window.location.origin);

export default function App(){

  const [events,setEvents] = useState([]);
  const [orders,setOrders] = useState([]);
  const [sector,setSector] = useState([]);
  const [radar,setRadar] = useState([]);

  useEffect(()=>{

    loadRadar();

    const timer = setInterval(loadRadar,10000);

    socket.on("market_events",(data)=>{
      setEvents(prev=>[...data,...prev].slice(0,10));
    });

    socket.on("order_book_update",(data)=>{
      setOrders(prev=>[data,...prev].slice(0,10));
    });

    socket.on("sector_alerts",(data)=>{
      setSector(prev=>[...data,...prev].slice(0,10));
    });

    socket.on("sector_boom",(data)=>{
      setSector(prev=>[data,...prev].slice(0,10));
    });

    return ()=>clearInterval(timer);

  },[]);

  async function loadRadar(){

    const res = await fetch("/api/radar");
    const data = await res.json();
    setRadar(data);

  }

  function scoreColor(score){

    if(score >= 80) return "#00ff9c";
    if(score >= 50) return "#ffcc00";
    return "#aaa";

  }

  return(

    <div className="container">

      <h1 style={{marginBottom:"25px"}}>
        ⭐ Market Intelligence Dashboard
      </h1>

      {/* RADAR */}

      <div style={{marginBottom:"40px"}}>

        <h2>⭐ Market Radar</h2>

        <div style={{
          display:"grid",
          gridTemplateColumns:"repeat(5,1fr)",
          gap:"10px"
        }}>

          {radar.map((r,i)=>(

            <div
              key={i}
              style={{
                background:"#012a5c",
                padding:"12px",
                borderRadius:"6px",
                border:`2px solid ${scoreColor(r.score)}`
              }}
            >

              <div style={{fontWeight:"bold"}}>
                {r.company}
              </div>

              <div style={{color:scoreColor(r.score)}}>
                Score: {r.score}
              </div>

              <div style={{fontSize:"12px",opacity:.8}}>
                {r.signals.join(", ")}
              </div>

            </div>

          ))}

        </div>

      </div>

      {/* GRID */}

      <div className="grid">

        {/* EVENTS */}

        <div>

          <h2>📢 Live Market Events</h2>

          {events.map((e,i)=>(
            <div className="card" key={i}>
              <b>{e.company}</b>
              <div style={{fontSize:"13px"}}>
                {e.title}
              </div>
            </div>
          ))}

        </div>

        {/* ORDER BOOK */}

        <div>

          <h2>📦 Order Book Updates</h2>

          {orders.map((o,i)=>(
            <div className="card" key={i}>
              <b>{o.company}</b>
              <div>
                Total Orders: ₹{o.totalOrderValue} Cr
              </div>
            </div>
          ))}

        </div>

        {/* SECTOR */}

        <div>

          <h2>🚀 Sector Momentum</h2>

          {sector.map((s,i)=>(
            <div className="card" key={i}>
              <b>{s.sector}</b>
              <div>
                Orders: {s.orders || s.companies}
              </div>
              <div>
                Value: ₹{s.value || s.totalValue} Cr
              </div>
            </div>
          ))}

        </div>

      </div>

    </div>

  );

}