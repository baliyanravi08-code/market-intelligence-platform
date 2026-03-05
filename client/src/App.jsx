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

    return ()=>clearInterval(timer);

  },[]);

  async function loadRadar(){

    const res = await fetch("/api/radar");

    const data = await res.json();

    setRadar(data);

  }

  return(

    <div className="container">

      <h1>⭐ Market Intelligence Dashboard</h1>

      <h2>⭐ Market Radar</h2>

      {radar.map((r,i)=>(
        <div className="card" key={i}>
          <b>{r.company}</b>
          <div>Score: {r.score}</div>
          <div>{r.signals.join(", ")}</div>
        </div>
      ))}

      <div className="grid">

        <div>

          <h2>📢 Market Events</h2>

          {events.map((e,i)=>(
            <div className="card" key={i}>
              <b>{e.company}</b>
              <div>{e.title}</div>
            </div>
          ))}

        </div>

        <div>

          <h2>📦 Order Book Updates</h2>

          {orders.map((o,i)=>(
            <div className="card" key={i}>
              <b>{o.company}</b>
              <div>Total Orders: ₹{o.totalOrderValue} Cr</div>
            </div>
          ))}

        </div>

        <div>

          <h2>🚀 Sector Signals</h2>

          {sector.map((s,i)=>(
            <div className="card" key={i}>
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