function detectOrders(announcement){

 if(!announcement)
  return null;

 const text = announcement.toLowerCase();

/*
Detect patterns:
₹50 crore
50 crore
50 cr
₹3.5 cr
*/

 const regex =
 /₹?\s*(\d+(?:\.\d+)?)\s*(crore|cr)/g;

 let match;
 const orders=[];

 while((match = regex.exec(text)) !== null){

  const value =
   parseFloat(match[1]);

  if(value >= 1){

   orders.push({
    value:value,
    unit:"crore"
   });

  }

 }

 if(!orders.length)
  return null;

/*
TOTAL ORDER VALUE
*/

 const totalOrderValue =
  orders.reduce(
   (sum,o)=>sum+o.value,
   0
  );

 return{
  orders,
  totalOrderValue
 };

}

module.exports = detectOrders;