import { useEffect, useState } from "react";
import { io } from "socket.io-client";
import "./App.css";

const socket = io(window.location.origin);

export default function App(){

  const [events,setEvents] = useState([]);
  const [sector,setSector] = useState([]);
  const [radar,setRadar] = useState([]);
  const [selectedSignal,setSelectedSignal] = useState(null);

  useEffect(()=>{

    loadRadar();

    const timer = setInterval(loadRadar,10000);

    socket.on("market_events",(data)=>{
      setEvents(prev=>[...data,...prev].slice(0,20));
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

    try{

      const res = await fetch("/api/radar");
      const data = await res.json();
      setRadar(data);

    }catch(err){
      console.log("Radar fetch failed",err);
    }

  }

  function scoreColor(score){

    if(score >= 80) return "#00ff9c";
    if(score >= 50) return "#ffcc00";
    if(score >= 20) return "#ff8800";
    return "#aaa";

  }

  function openSignal(company,signal,score){

    setSelectedSignal({
      company,
      signal,
      score
    });

  }

  function closeSignal(){
    setSelectedSignal(null);
  }

  return(

    <div className="container">

      <h1>⭐ Market Intelligence Terminal</h1>

      {/* RADAR */}

      <div className="section">

        <h2>⭐ Market Radar</h2>

        <table className="table">

          <thead>

            <tr>
              <th>Company</th>
              <th>Score</th>
              <th>Signals</th>
            </tr>

          </thead>

          <tbody>

            {radar.map((r,i)=>(

              <tr
                className="row"
                key={i}
                style={{
                  borderLeft:`4px solid ${scoreColor(r.score)}`
                }}
              >

                <td>{r.company}</td>

                <td style={{color:scoreColor(r.score)}}>
                  {r.score}
                </td>

                <td>

                  {r.signals.map((s,j)=>(
                    <span
                      className="tag"
                      key={j}
                      style={{cursor:"pointer"}}
                      onClick={()=>openSignal(r.company,s,r.score)}
                    >
                      {s}
                    </span>
                  ))}

                </td>

              </tr>

            ))}

          </tbody>

        </table>

      </div>

      {/* GRID */}

      <div className="grid">

        {/* EVENTS */}

        <div>

          <h2>📢 Live Alerts</h2>

          <div className="events">

            {events.map((e,i)=>(
              <div className="event-card" key={i}>
                <b>{e.company}</b>
                <div>{e.title}</div>
              </div>
            ))}

          </div>

        </div>

        {/* SECTOR */}

        <div>

          <h2>🚀 Sector Momentum</h2>

          {sector.map((s,i)=>(

            <div className="event-card" key={i}>

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

      {/* SIGNAL DETAIL PANEL */}

      {selectedSignal && (

        <div
          style={{
            position:"fixed",
            right:0,
            top:0,
            width:"320px",
            height:"100vh",
            background:"#012a5c",
            padding:"20px",
            borderLeft:"2px solid #014a96"
          }}
        >

          <h3>Signal Detail</h3>

          <div style={{marginTop:"15px"}}>

            <b>Company</b>
            <div>{selectedSignal.company}</div>

          </div>

          <div style={{marginTop:"15px"}}>

            <b>Signal</b>
            <div>{selectedSignal.signal}</div>

          </div>

          <div style={{marginTop:"15px"}}>

            <b>Radar Score</b>
            <div>{selectedSignal.score}</div>

          </div>

          <button
            onClick={closeSignal}
            style={{
              marginTop:"30px",
              padding:"8px 15px",
              background:"#014a96",
              color:"white",
              border:"none",
              cursor:"pointer"
            }}
          >
            Close
          </button>

        </div>

      )}

    </div>

  );

}