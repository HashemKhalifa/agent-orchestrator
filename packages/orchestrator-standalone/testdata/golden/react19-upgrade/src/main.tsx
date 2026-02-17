import React, { useEffect } from "react";
import ReactDOM from "react-dom";

function App() {
  useEffect(() => {
    const id = setInterval(() => {}, 1000);
    return () => clearInterval(id);
  }, []);

  return <div>hello</div>;
}

ReactDOM.render(<App />, document.getElementById("root"));
