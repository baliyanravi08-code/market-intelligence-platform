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
      setEvents(prev=>[...data,...prev].slice(0,30));
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

    <div className="terminal">

      <div className="header">
        ⭐ Market Intelligence Terminal
      </div>

      <div className="layout">

        {/* LEFT PANEL */}

        <div className="radar-panel">

          <h3>Radar</h3>

          {radar.map((r,i)=>(

            <div className="radar-card" key={i}>

              <div className="radar-row">

                <span className="company">
                  {r.company}
                </span>

                <span
                  className="score"
                  style={{color:scoreColor(r.score)}}
                >
                  {r.score}
                </span>

              </div>

              <div className="signals">

                {r.signals.map((s,j)=>(
                  <span
                    key={j}
                    className="tag"
                    onClick={()=>alert(`${r.company}\nSignal: ${s}`)}
                  >
                    {s}
                  </span>
                ))}

              </div>

            </div>

          ))}

        </div>

        {/* CENTER PANEL */}

        <div className="feed-panel">

          <h3>Live Alerts</h3>

          <div className="feed">

            {events.map((e,i)=>(

              <div className="feed-card" key={i}>

                <div className="feed-title">
                  {e.company}
                </div>

                <div className="feed-text">
                  {e.title}
                </div>

                {e.pdfUrl && (
                  <a
                    href={e.pdfUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="pdf-link"
                  >
                    View Filing
                  </a>
                )}

              </div>

            ))}

          </div>

        </div>

        {/* RIGHT PANEL */}

        <div className="sector-panel">

          <h3>Sector Momentum</h3>

          {sector.map((s,i)=>(

            <div className="sector-card" key={i}>

              <div className="sector-title">
                {s.sector}
              </div>

              <div>
                Orders: {s.orders}
              </div>

              <div>
                Companies:
                <div className="sector-companies">
                  {s.companies?.join(", ")}
                </div>
              </div>

              <div>
                Value: ₹{s.totalValue} Cr
              </div>

            </div>

          ))}

        </div>

      </div>

    </div>

  );

}