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

    if(score>=100) return "#00ff9c";
    if(score>=70) return "#ffcc00";
    if(score>=40) return "#ff8800";

    return "#aaa";

  }

  function opportunityColor(level){

    if(level==="VERY_HIGH") return "#00ff9c";

    if(level==="HIGH") return "#ffcc00";

    if(level==="MEDIUM") return "#ff8800";

    return "#aaa";

  }

  return(

    <div className="container">

      <h1>⭐ Market Intelligence Terminal</h1>

      <div className="section">

        <h2>⭐ Market Radar</h2>

        <table className="table">

          <thead>

            <tr>
              <th>Company</th>
              <th>Score</th>
              <th>Opportunity</th>
              <th>Signals</th>
            </tr>

          </thead>

          <tbody>

            {radar.map((r,i)=>(

              <tr key={i} className="row">

                <td>{r.company}</td>

                <td style={{color:scoreColor(r.score)}}>
                  {r.score}
                </td>

                <td style={{color:opportunityColor(r.opportunity)}}>
                  {r.opportunity}
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

      <div className="grid">

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