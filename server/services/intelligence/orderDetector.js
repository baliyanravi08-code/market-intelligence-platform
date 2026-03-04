function detectOrder(announcement){

 if(!announcement)
  return null;

 const text =
  announcement.toLowerCase();

/*
Extract order values like:
₹10 crore
10 crore
100 cr
*/

 const regex =
  /(\d+(?:\.\d+)?)\s*(crore|cr)/g;

 let match;
 let orders=[];

 while((match=regex.exec(text))!==null){

  const value =
   parseFloat(match[1]);

  if(value>=1){

   orders.push({
    value:value,
    currency:"INR",
    unit:"crore"
   });

  }

 }

 if(!orders.length)
  return null;

 return orders;
}

module.exports = detectOrder;