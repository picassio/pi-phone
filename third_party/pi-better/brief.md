The brief below is for a subagent that starts with none of this conversation: it sees only the brief, the repo and its own tools. Without asking me anything, read the brief the way that subagent would, check it against the real code, files, docs and logs, and fix only what would trip it up. I want a brief the subagent can act on cold, not a bigger one.

## How to work

1. Keep every command quick; I'm waiting until you finish. Search the project and the paths the brief names, not whole home, session-log or cache directories (`~/.pi/agent/sessions` alone can hold tens of gigabytes). Give any command that might be slow a `timeout` of 30 seconds or less, and when one times out, narrow it instead of retrying it.
2. In a few lines each, using concrete facts from what you found:
   (1) List what the subagent can't resolve on its own: references to things only this conversation explains ("the bug we found", "option B", "as discussed"), decisions the brief relies on but doesn't state, and files, commands or setup it assumes.
   (2) Check every path, symbol, line number, command and version the brief names against the repo as it is now, and list what is wrong or out of date with the correct value.
   (3) Say how the subagent will know it's done. If the brief doesn't say, find the real check here: a test, a command, an output, a file to compare.
3. Rewrite the brief with only those gaps fixed: put the missing facts in, correct what's wrong, and add the check from (3) if it was missing. Keep its goal, scope, order, wording and length as close to the original as you can. Don't add work it doesn't ask for. If nothing needs fixing, return it unchanged.

Never carry the brief out. Don't edit files, start work, or launch anything; you only read and rewrite.
