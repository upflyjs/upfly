# upfly-mcp

The commands of [Upfly](https://www.npmjs.com/package/upfly) as an MCP server, for an app that
reaches tools only through MCP, such as Claude Desktop.

Upfly finds the images in a project and the references to them in the files it can read, converts
and moves images, and rewrites those references in one change that `undo` puts back. I built it as
a command-line tool, and that stays the main way in: an agent that can run a shell does better with
the `upfly` CLI and the `AGENTS.md` and Agent Skill that ship in it (`npx upfly init --agents` sets
them up for your agents). This package is for the apps that cannot run a command. It adds nothing
the CLI does not do: each tool runs the command of its name with the `upfly` installed beside it,
in the same version, and answers with the JSON line that command prints with `--json`.

## Register it

`upfly-mcp <folder>` serves the project in `<folder>` over standard input and output. In Claude
Desktop's config, and in that of most clients:

```json
{
  "mcpServers": {
    "upfly": { "command": "npx", "args": ["-y", "upfly-mcp", "/path/to/project"] }
  }
}
```

With Claude Code:

```sh
claude mcp add upfly -- npx -y upfly-mcp /path/to/project
```

On Windows, a client that cannot start `npx` itself takes `"command": "cmd"` with `"/c", "npx"`
before the same arguments.

## The seven tools

| tool | what it does |
|---|---|
| `audit` | reports the images, the references to them, the references that name no file, the images nothing references, and what `optimize` would save |
| `check` | fails when a reference names an image that does not exist |
| `refs` | lists every line that names one image, and whether Upfly could rewrite each |
| `optimize` | converts each image that comes out smaller as WebP or AVIF, rewrites its references, and removes the original once nothing Upfly reads still names it (`keepOriginals` keeps it) |
| `dedupe` | points the references to identical copies of an image at one copy; deletes nothing |
| `move` | moves an image, or the images in a folder, and rewrites the references Upfly can rewrite; deletes nothing |
| `undo` | puts back every file the last `optimize`, `dedupe` or `move` changed |

`audit`, `check` and `refs` change no file. `optimize`, `dedupe` and `move` answer with their plan,
and write only when a call sets `apply` to true; then they refuse what the command refuses:
uncommitted changes, an earlier run that stopped part way, a merge or a rebase in progress. `undo`
writes only when a call sets `apply` to true. No tool runs `init`, and none writes over uncommitted
work. Each answer is a JSON line whose schema ships in the `upfly` package.

## License

MIT
