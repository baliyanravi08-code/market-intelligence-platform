import { useEffect, useState } from "react";
import { io } from "socket.io-client";

const socket = io();

export default function App(){

 const [announcements,setAnnouncements]
 = useState([]);

 useEffect(()=>{

  socket.on("announcement",(data)=>{

   setAnnouncements(prev=>[
    data,
    ...prev.slice(0,9)
   ]);

  });

 },[]);

 return(

  <div style={{
   background:"#06142b",
   minHeight:"100vh",
   padding:"30px",
   color:"white"
  }}>

   <h1>
    🇮🇳 Market Intelligence Dashboard
   </h1>

   {announcements.map((item,index)=>(

    <div key={index}
     style={{
      background:"#102542",
      padding:"20px",
      margin:"15px 0",
      borderRadius:"10px"
     }}>

     <h3>{item.company}</h3>

     <p>Sector: {item.sector}</p>

     <p><b>Verdict:</b> {item.verdict}</p>

     <p><b>Reason:</b> {item.reason}</p>

     <p><b>QoQ:</b> {item.qoqSignal}</p>

     <p><b>YoY:</b> {item.yoySignal}</p>

     <p><b>Insight:</b> {item.insight}</p>

     <p>{item.time}</p>

    </div>

   ))}

  </div>
 );
}