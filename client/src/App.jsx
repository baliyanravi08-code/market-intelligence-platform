import { useEffect, useState } from "react";

export default function App(){

  const [radar,setRadar] = useState([]);

  useEffect(()=>{

    loadRadar();

    const timer = setInterval(loadRadar,10000);

    return ()=>clearInterval(timer);

  },[]);

  async function loadRadar(){

    const res = await fetch("/radar");

    const data = await res.json();

    setRadar(data);

  }

  return(

    <div style={{
      background:"#001b3a",
      minHeight:"100vh",
      color:"white",
      padding:"40px",
      fontFamily:"Arial"
    }}>

      <h1>⭐ Market Radar</h1>

      {radar.map((r,i)=>(
        <div key={i}
          style={{
            background:"#012a5c",
            padding:"15px",
            borderRadius:"8px",
            marginBottom:"15px"
          }}
        >

          <b>{r.symbol}</b>

          <div>Score: {r.score}</div>

          <div>Signals: {r.signals.join(", ")}</div>

        </div>
      ))}

    </div>

  );

}