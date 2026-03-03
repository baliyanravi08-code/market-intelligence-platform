import { useEffect, useState } from "react";
import { io } from "socket.io-client";

const socket = io();

export default function App() {

  const [announcements,setAnnouncements]=useState([]);

  useEffect(()=>{

    socket.on("announcement",(data)=>{

      console.log("LIVE DATA:",data);

      setAnnouncements(prev=>[
        data,
        ...prev
      ]);

    });

    return ()=>{
      socket.off("announcement");
    };

  },[]);

  return (
    <div style={{
      background:"#020b1c",
      color:"white",
      minHeight:"100vh",
      padding:"30px"
    }}>

      <h1>🇮🇳 Market Intelligence Dashboard</h1>

      <h3>Live Announcements</h3>

      {announcements.map((item,index)=>(
        <div key={index}
          style={{
            background:"#0c1f3f",
            padding:"15px",
            margin:"10px 0",
            borderRadius:"8px"
          }}
        >
          <h4>{item.company}</h4>
          <p>Sector: {item.sector}</p>
          <p>Strength: {item.strengthScore}</p>
          <p>Status: {item.marketStatus}</p>
          <p>{item.time}</p>
        </div>
      ))}

    </div>
  );
}