import {useEffect,useState} from "react";
import {io} from "socket.io-client";

const socket=io();

export default function App(){

 const[ann,setAnn]=useState([]);

 useEffect(()=>{

  socket.on("announcement",(data)=>{

   setAnn(prev=>[
    data,
    ...prev.slice(0,9)
   ]);

  });

 },[]);

 return(

  <div style={{
   background:"#06142b",
   color:"white",
   minHeight:"100vh",
   padding:"30px"
  }}>

   <h1>Market Intelligence</h1>

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

     <p>MarketCap: {item.marketCap}</p>

     <p>Insight: {item.insight}</p>

     <p>PDF Insight: {item.pdfInsight}</p>

     {item.orders && (

      <div>

       <b>Orders Detected:</b>

       {item.orders.map((o,index)=>(

        <p key={index}>
         ₹{o.value} Crore Order
        </p>

       ))}

      </div>

     )}

     <p>{item.time}</p>

    </div>

   ))}

  </div>
 );
}