import {useEffect,useState} from "react";
import {io} from "socket.io-client";

const socket=io();

export default function App(){

 const[ann,setAnn]=useState([]);
 const[sector,setSector]=useState({});
 const[market,setMarket]=useState({});

 useEffect(()=>{

  socket.on("announcement",(data)=>{

   setAnn(prev=>[
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
   color:"white"
  }}>

   <h1>🇮🇳 Market Intelligence</h1>

   <h2>
    Market Direction:
    {market.status}
   </h2>

   <h3>
    Market Score:
    {market.score?.toFixed?.(2)}
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

   {ann.map((item,i)=>(

    <div key={i}
     style={{
      background:"#102542",
      padding:"20px",
      margin:"15px 0",
      borderRadius:"10px"
     }}>

     <h3>{item.company}</h3>
     <p>Sector: {item.sector}</p>
     <p>Verdict: {item.verdict}</p>
     <p>Insight: {item.insight}</p>
     <p>{item.time}</p>

    </div>

   ))}

  </div>
 );
}