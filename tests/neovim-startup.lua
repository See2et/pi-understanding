-- Invoked by -c after the exact production launch args, not Neovim's -l script mode.
-- Required invariants fail the process, rather than being masked by a later qa! command.
local ok, err = xpcall(function()
  assert(vim.g.user_init_loaded == 'isolated-init', 'normal user init.lua must load')
  assert(vim.g.user_plugin_loaded == 'isolated-runtime-plugin', 'normal user runtime plugin must load')
  assert(vim.o.scrolloff == 7, 'user option must survive receiver startup')
  assert(vim.fn.maparg('<F6>', 'n', false, true).desc == 'Isolated user mapping', 'user mapping must survive receiver startup')
  vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes('<F6>', true, false, true), 'xt', false)
  assert(vim.g.user_mapping_used == 1, 'user mapping must be usable in the selected evidence buffer')
  assert(vim.o.shadafile == 'NONE' and not vim.bo.swapfile, 'viewer ShaDa and swap must remain disabled')
  assert(not vim.g.handoff_injected, 'source metacharacters and modelines must not execute')
  local data = vim.json.decode(table.concat(vim.fn.readfile(vim.env.PI_UNDERSTANDING_NVIM_HANDOFF), '\n'))
  local buf = vim.api.nvim_get_current_buf()
  assert(#vim.api.nvim_tabpage_list_wins(0) == 1, 'new viewer must show only the evidence pane, without an empty split')
  if vim.env.PI_UNDERSTANDING_TEST_FAIL_READONLY == '1' then vim.bo[buf].readonly = false end
  assert(vim.bo[buf].readonly and not vim.bo[buf].modifiable, 'startup evidence buffer must be readonly and nonmodifiable')
  assert(vim.bo[buf].buftype == 'nofile' and not vim.bo[buf].modeline, 'startup must select the fixed scratch buffer')
  local source = table.concat(vim.api.nvim_buf_get_lines(buf, 0, -1, false), '\n')
  assert(source == data.source, 'startup must show every whole fixed source line')
  assert(vim.deep_equal(vim.b[buf].pi_understanding_identity, data.identity), 'startup fixed source identity mismatch')
  assert(vim.deep_equal(vim.b[buf].pi_understanding_evidence, { start = data.evidence.start, ['end'] = data.evidence['end'] }), 'startup evidence range mismatch')
  assert(vim.api.nvim_win_get_cursor(0)[1] == data.evidence.start, 'startup cursor must select the evidence start')
  local namespaces = vim.api.nvim_get_namespaces()
  local range = vim.api.nvim_buf_get_extmarks(buf, namespaces['pi-understanding-range'], 0, -1, { details = true })
  assert(#range == 1 and range[1][2] == data.evidence.start - 1 and range[1][4].end_row == data.evidence['end'], 'startup range highlight mismatch')
  local marks = vim.api.nvim_buf_get_extmarks(buf, namespaces['pi-understanding-annotations'], 0, -1, { details = true })
  assert(#marks == #data.evidence.annotations, 'startup must show the actual shared annotations')
  for i, mark in ipairs(marks) do
    local annotation = data.evidence.annotations[i]
    assert(mark[2] == annotation.start - 1, 'startup annotation range mismatch')
    local parts = {}
    for _, row in ipairs(mark[4].virt_lines) do for _, chunk in ipairs(row) do parts[#parts + 1] = chunk[1] end end
    assert(table.concat(parts) == ('AI interpretation L%d-%d: %s'):format(annotation.start, annotation['end'], annotation.text), 'startup annotation text mismatch')
  end
  io.stdout:write(vim.json.encode({ status = 'STARTUP_CONTRACT_OK', buffer = buf, readonly = vim.bo[buf].readonly,
    modifiable = vim.bo[buf].modifiable, source = source, identity = vim.b[buf].pi_understanding_identity,
    evidence = vim.b[buf].pi_understanding_evidence, range = range, annotations = marks,
    userConfig = { init = vim.g.user_init_loaded, plugin = vim.g.user_plugin_loaded, scrolloff = vim.o.scrolloff,
      mappingUsed = vim.g.user_mapping_used, shadafile = vim.o.shadafile, swapfile = vim.bo[buf].swapfile } }) .. '\n')
  io.stdout:flush()
end, debug.traceback)
if not ok then
  io.stderr:write(tostring(err) .. '\n'); io.stderr:flush()
  vim.cmd('cquit 1')
end
vim.cmd('qa!')
