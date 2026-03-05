function extractCompany(title){

 const parts=title.split("-");

 if(parts.length>0)
  return parts[0].trim();

 return "UNKNOWN";
}

module.exports={
 extractCompany
};