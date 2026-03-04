import { useEffect, useState } from "react";
import { io } from "socket.io-client";

const socket = io();

export default function App(){

 const [announcements,setAnnouncements]=useState([]);
 const [sector,setSector]=useState({});
 const [market,setMarket]=useState({});

 useEffect(()=>{

  socket.on("announcement",(data)=>{

   setAnnouncements(prev=>[
    data,
    ...prev.slice(0,9)
   ]);

   setSector(data.sectorStrength);

   setMarket({
    status:data.marketStatus,
    score:data.marketScore
   });

  });

 },[]);

 return(

  <div style={{
   background:"#06142b",
   minHeight:"100vh",
   padding:"30px",
   color:"white",
   fontFamily:"Arial"
  }}>

   <h1>🇮🇳 Market Intelligence Dashboard</h1>

   <h2>
    Market Direction: {market.status}
   </h2>

   <h3>
    Market Score: {market.score?.toFixed?.(2)}
   </h3>

   <hr/>

   <h2>Sector Strength</h2>

   {Object.entries(sector).map(
    ([name,value])=>(
     <div key={name}>
      {name}: {value}
     </div>
   ))}

   <hr/>

   <h2>Live Result Intelligence</h2>

   {announcements.map((item,index)=>(

    <div
     key={index}
     style={{
      background:"#102542",
      padding:"20px",
      margin:"15px 0",
      borderRadius:"10px"
     }}
    >

     <h3>{item.company}</h3>

     <p><b>Sector:</b> {item.sector}</p>

     <p><b>Verdict:</b> {item.verdict}</p>

     <p><b>Reason:</b> {item.reason}</p>

     <p><b>QoQ:</b> {item.qoqSignal}</p>

     <p><b>YoY:</b> {item.yoySignal}</p>

     <p><b>Insight:</b> {item.insight}</p>

     <p><b>PDF Insight:</b> {item.pdfInsight}</p>

     <p><b>PDF Reason:</b> {item.pdfReason}</p>

     <p>{item.time}</p>

    </div>

   ))}

  </div>
 );
}