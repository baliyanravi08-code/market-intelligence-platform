function getResultPDF(){

 const samples=[

  "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf"

 ];

 return samples[
  Math.floor(Math.random()*samples.length)
 ];

}

module.exports = getResultPDF;