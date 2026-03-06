import { useEffect,useState } from "react";
import { io } from "socket.io-client";
import "./App.css";

const socket = io(window.location.origin);

export default function App(){

  const [events,setEvents] = useState([]);
  const [sector,setSector] = useState([]);
  const [radar,setRadar] = useState([]);

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

    const res = await fetch("/api/radar");
    const data = await res.json();
    setRadar(data);

  }

  function scoreColor(score){

    if(score>=80) return "#00ff9c";
    if(score>=50) return "#ffcc00";
    return "#aaa";

  }

  return(

    <div className="container">

      <h1>⭐ Market Intelligence Terminal</h1>

      {/* RADAR TABLE */}

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

              <tr className="row" key={i}>

                <td>{r.company}</td>

                <td style={{color:scoreColor(r.score)}}>
                  {r.score}
                </td>

                <td>

                  {r.signals.map((s,j)=>(
                    <span className="tag" key={j}>
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

    </div>

  );

}