# Hawkin Dynamics MCP connector

Read-only MCP server that gives Claude chats, Claude Code and Codex access to
Teamwork Bloomington's Hawkin force-plate data. The Hawkin integration key lives
only in the Render env var `HD_REFRESH_TOKEN`.

Render: build `pip install -r hawkin-mcp/requirements.txt`, start `python hawkin-mcp/server.py`.
Env: `HD_REFRESH_TOKEN`, `MCP_SECRET` (connector URL is `https://<service>.onrender.com/<MCP_SECRET>/mcp`).

Tools: hawkin_find_athlete, hawkin_list_teams_groups, hawkin_get_tests,
hawkin_metric_summary, hawkin_metric_definitions, hawkin_force_time.
