import pathlib

p = pathlib.Path("server/src/agent-member.test.ts")
s = p.read_text()

start = s.rindex("/**\n * What a member reads of the group's standing instruction")
end = s.index('test("the agent surfaces an administrator edits are shut to this session"')
removed = s[start:end]
assert "remarks do not reach a member" in removed, "the block to remove is the old test"
s = s[:start] + s[end:]
p.write_text(s)
print("removed", len(removed), "chars")
