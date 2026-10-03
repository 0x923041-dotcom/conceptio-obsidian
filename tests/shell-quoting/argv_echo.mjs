// Prints the argv a program actually receives, as JSON.
//
// Exists so the quoting of the documented Obsidian CLI spelling can be compared
// like for like across shells: the shell is the one layer that differs between a
// user's terminal and `tests/runtime_check.mjs`, which spawns the client with no
// shell at all.
console.log(JSON.stringify(process.argv.slice(2)));
