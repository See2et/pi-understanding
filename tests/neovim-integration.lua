-- Real Neovim acceptance through standard APIs, with no user config or plugins.
local ok, err = xpcall(function()
  vim.opt.runtimepath:prepend(vim.env.PI_UNDERSTANDING_TEST_PLUGIN)
  local m = require('pi_understanding')
  local manifest = vim.json.decode(table.concat(vim.fn.readfile(vim.env.PI_UNDERSTANDING_TEST_MANIFEST), '\n'))
  local original = vim.api.nvim_get_current_buf()
  local original_window = vim.api.nvim_get_current_win()
  vim.api.nvim_buf_set_lines(original, 0, -1, false, { 'user work remains here' })
  local data = vim.json.decode(table.concat(vim.fn.readfile(manifest.file), '\n'))
  local buf = m.open(manifest.file)
  assert(vim.api.nvim_get_current_buf() == buf)
  assert(#vim.api.nvim_tabpage_list_wins(0) == 2, 'existing viewer must open a split')
  assert(vim.api.nvim_win_get_buf(original_window) == original, 'existing work window must remain visible')
  assert(vim.api.nvim_buf_get_lines(original, 0, -1, false)[1] == 'user work remains here')
  assert(vim.bo[original].modified, 'user draft must not be saved or replaced')
  assert(vim.bo[buf].readonly and not vim.bo[buf].modifiable and not vim.bo[buf].modified)
  assert(vim.bo[buf].buftype == 'nofile' and not vim.bo[buf].swapfile and not vim.bo[buf].modeline)
  local lines = vim.api.nvim_buf_get_lines(buf, 0, -1, false)
  assert(table.concat(lines, '\n') == data.source, 'whole fixed source including trailing line and outside evidence')
  assert(lines[1] == 'outside-before' and lines[#lines - 1] == 'outside-after')
  assert(not vim.g.handoff_injected, 'original source/annotation was not evaluated')
  assert(vim.api.nvim_win_get_cursor(0)[1] == data.evidence.start)
  assert(vim.wo.number and not vim.wo.relativenumber)
  assert(m.identity(buf):find(data.identity.digest, 1, true))
  assert(m.identity(buf):find(data.identity.snapshot, 1, true))
  local range = vim.api.nvim_buf_get_extmarks(buf, m.namespaces.range, 0, -1, { details = true })
  assert(#range == 1 and range[1][2] == data.evidence.start - 1 and range[1][4].end_row == data.evidence['end'])
  local marks = vim.api.nvim_buf_get_extmarks(buf, m.namespaces.annotations, 0, -1, { details = true })
  assert(#marks == #data.evidence.annotations)
  for i, mark in ipairs(marks) do
    assert(mark[2] == data.evidence.annotations[i].start - 1)
    local displayed = {}
    for _, row in ipairs(mark[4].virt_lines) do for _, chunk in ipairs(row) do displayed[#displayed + 1] = chunk[1] end end
    assert(table.concat(displayed):find(data.evidence.annotations[i].text, 1, true), 'same AI text in virtual lines')
  end
  m.navigate(1, true, buf); assert(vim.api.nvim_win_get_cursor(0)[1] == data.evidence.annotations[2].start)
  m.navigate(1, true, buf); assert(vim.api.nvim_win_get_cursor(0)[1] == data.evidence.annotations[1].start)
  m.navigate(-1, true, buf); assert(vim.api.nvim_win_get_cursor(0)[1] == data.evidence.annotations[2].start)
  m.navigate(1, false, buf); assert(vim.api.nvim_win_get_cursor(0)[1] == data.evidence['end'])
  m.navigate(1, false, buf); assert(vim.api.nvim_win_get_cursor(0)[1] == data.evidence.start)
  -- Exercise the actual buffer-local toggle mapping, then restore it through the public API.
  local mapping
  for _, map in ipairs(vim.api.nvim_buf_get_keymap(buf, 'n')) do if map.lhs == 'ga' then mapping = map end end
  assert(mapping and mapping.callback); mapping.callback()
  assert(#vim.api.nvim_buf_get_extmarks(buf, m.namespaces.annotations, 0, -1, {}) == 0)
  assert(vim.b[buf].pi_understanding_annotations_visible == false)
  m.toggle(buf); assert(#vim.api.nvim_buf_get_extmarks(buf, m.namespaces.annotations, 0, -1, {}) == #marks)
  assert(not pcall(vim.api.nvim_buf_set_lines, buf, 0, 1, false, { 'mutated' }), 'normal editing must fail')
  assert(not pcall(vim.cmd, 'write! ' .. vim.fn.fnameescape(manifest.forbidden_write)), 'nofile write must fail')
  assert(vim.uv.fs_stat(manifest.forbidden_write) == nil)
  assert(table.concat(vim.api.nvim_buf_get_lines(buf, 0, -1, false), '\n') == data.source)
  local failures = {}
  for _, file in ipairs(manifest.bad) do
    local count = #vim.api.nvim_list_bufs()
    local opened, reason = pcall(m.open, file)
    assert(not opened, 'malformed/unsafe handoff must fail: ' .. file)
    assert(#vim.api.nvim_list_bufs() == count and vim.api.nvim_get_current_buf() == buf, 'failure must not disturb evidence or user work')
    failures[#failures + 1] = tostring(reason)
  end
  local hidden = m.open(manifest.hidden)
  assert(#vim.api.nvim_buf_get_extmarks(hidden, m.namespaces.annotations, 0, -1, {}) == 0)
  m.toggle(hidden); assert(#vim.api.nvim_buf_get_extmarks(hidden, m.namespaces.annotations, 0, -1, {}) == #marks)
  local legacy = m.open(manifest.legacy)
  assert(#vim.api.nvim_buf_get_extmarks(legacy, m.namespaces.annotations, 0, -1, {}) == 0)
  m.navigate(1, true, legacy) -- no annotations is a safe no-op
  m.toggle(legacy)
  local report = { version = vim.version(), lines = #lines, evidence = data.evidence,
    identity = data.identity, range = range, annotations = marks, failures = failures,
    nonmutation = true, readonly = true, preserved_user_draft = true }
  vim.fn.writefile({ vim.json.encode(report) }, manifest.report)
end, debug.traceback)
if not ok then vim.api.nvim_err_writeln(err); vim.cmd('cquit 1') end
vim.cmd('qa!')
