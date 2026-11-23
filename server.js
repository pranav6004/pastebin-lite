import app from "./app.js";

const port = process.env.PORT || 3000;
app.listen(port, "127.0.0.1", () => console.log(`Pastebin Lite is listening on http://127.0.0.1:${port}`));
