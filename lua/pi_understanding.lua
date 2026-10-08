-- One-way fixed evidence viewer. No AI, file edits, watchers, shell, or evaluated handoff code.
local M = {}
local uv = vim.uv or vim.loop
M.namespaces = {
  annotations = vim.api.nvim_create_namespace('pi-understanding-annotations'),
  range = vim.api.nvim_create_namespace('pi-understanding-range'),
  identity = vim.api.nvim_create_namespace('pi-understanding-identity'),
}
local states = {}
local function fail(message) error('pi-understanding: ' .. message, 0) end
local function check(ok, message) if not ok then fail(message) end end
local function integer(n) return type(n) == 'number' and n == math.floor(n) end
local function plain(s, limit)
  return type(s) == 'string' and #s > 0 and #s <= limit
    and not s:find('[%z\1-\31\127]') and not s:find('\194[\128-\159]')
    and not s:find('\226\128[\168\169]') -- Unicode line/paragraph separators
end
local function nonblank(s)
  local text = s:gsub('%s', '')
  -- ECMAScript String.trim whitespace: match the producer's definition, including Unicode spaces.
  for _, cp in ipairs({ 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200,
    8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279 }) do text = text:gsub(vim.fn.nr2char(cp), '') end
  return #text > 0
end
local function private(stat, kind)
  return stat and stat.type == kind and stat.uid == uv.getuid()
    and bit.band(stat.mode, 63) == 0
end
local function read_private(file)
  check(plain(file, 4096), 'invalid handoff path')
  local parent = vim.fs.dirname(file)
  check(private(uv.fs_lstat(parent), 'directory'), 'handoff directory must be private, owned and not a symlink')
  local before = uv.fs_lstat(file)
  check(private(before, 'file') and before.nlink == 1 and before.size <= 6200000, 'unsafe or oversized handoff')
  local fd, err = uv.fs_open(file, 'r', 0)
  check(fd, 'cannot open handoff: ' .. tostring(err))
  local ok, result = pcall(function()
    local after = uv.fs_fstat(fd)
    check(private(after, 'file') and after.nlink == 1 and after.ino == before.ino
      and after.dev == before.dev and after.size == before.size, 'handoff changed during open')
    local text = uv.fs_read(fd, after.size, 0)
    check(type(text) == 'string' and #text == after.size, 'incomplete handoff')
    return vim.json.decode(text)
  end)
  uv.fs_close(fd)
  if not ok then fail('invalid handoff: ' .. tostring(result)) end
  return result
end
local function validate(data)
  check(type(data) == 'table' and data.version == 1, 'unsupported handoff')
  local id, e = data.identity, data.evidence
  check(type(id) == 'table' and type(e) == 'table', 'missing identity/evidence')
  for _, k in ipairs({ 'scope', 'repository', 'snapshot', 'path', 'ref', 'digest' }) do
    check(plain(id[k], 1000), 'invalid identity ' .. k)
  end
  check(#id.digest == 64 and not id.digest:find('[^a-f0-9]'), 'invalid digest')
  check(not id.path:find('^/') and not id.path:find('[\\:]') and not id.path:find('//')
    and not id.path:find('/$'), 'invalid repository-relative path')
  for component in id.path:gmatch('[^/]+') do check(component ~= '.' and component ~= '..', 'invalid path component') end
  check(type(data.source) == 'string' and #data.source <= 1000000 and not data.source:find('%z'), 'invalid whole source')
  check(vim.fn.sha256(data.source) == id.digest, 'whole source digest mismatch')
  local lines = vim.split(data.source, '\n', { plain = true })
  check(e.path == id.path and e.ref == id.ref and integer(e.start) and integer(e['end'])
    and e.start >= 1 and e['end'] >= e.start and e['end'] - e.start <= 60 and e['end'] <= #lines, 'evidence range/binding mismatch')
  local quote = table.concat(lines, '\n', e.start, e['end'])
  check(type(e.quote) == 'string' and e.quote == quote and nonblank(quote), 'exact evidence quote mismatch')
  local annotations = e.annotations
  if annotations == nil then annotations = {} end
  check(type(annotations) == 'table' and vim.islist(annotations) and #annotations <= 6, 'invalid annotations')
  local previous, total = e.start - 1, 0
  for _, a in ipairs(annotations) do
    check(type(a) == 'table' and integer(a.start) and integer(a['end']) and a.start > previous
      and a.start >= e.start and a['end'] >= a.start and a['end'] <= e['end'], 'annotation range outside evidence or overlapping/unsorted')
    check(plain(a.text, 480) and nonblank(a.text), 'invalid annotation text')
    total = total + #a.text
    check(total <= 1440, 'annotation budget exceeded')
    previous = a['end']
  end
  check(type(data.annotationsVisible) == 'boolean', 'invalid annotation visibility')
  return lines, annotations
end
local function identity_text(s)
  local id, e = s.data.identity, s.data.evidence
  return ('%s:%s:%d-%d | scope=%s | snapshot=%s | repository=%s | sha256=%s'):format(
    id.ref, id.path, e.start, e['end'], id.scope, id.snapshot, id.repository, id.digest)
end
-- Virtual rows only: the buffer retains every original line and original line number.
local function render(buf)
  local s = states[buf]
  if not s or not vim.api.nvim_buf_is_valid(buf) then return end
  vim.api.nvim_buf_clear_namespace(buf, M.namespaces.annotations, 0, -1)
  if not s.visible then return end
  local width = math.max(20, vim.api.nvim_win_get_width(0) - 8)
  for _, a in ipairs(s.annotations) do
    local text = ('AI interpretation L%d-%d: %s'):format(a.start, a['end'], a.text)
    local rows, row, used = {}, '', 0
    for i = 0, vim.fn.strchars(text) - 1 do
      local char = vim.fn.strcharpart(text, i, 1)
      local w = vim.fn.strdisplaywidth(char)
      if used + w > width and #row > 0 then rows[#rows + 1] = { { row, 'DiagnosticInfo' } }; row, used = '', 0 end
      row, used = row .. char, used + w
    end
    rows[#rows + 1] = { { row, 'DiagnosticInfo' } }
    vim.api.nvim_buf_set_extmark(buf, M.namespaces.annotations, a.start - 1, 0, { virt_lines = rows, virt_lines_above = true })
  end
end
function M.toggle(buf)
  buf = buf or vim.api.nvim_get_current_buf()
  local s = states[buf]; check(s, 'not an evidence buffer')
  s.visible = not s.visible; vim.b[buf].pi_understanding_annotations_visible = s.visible
  render(buf)
end
function M.navigate(direction, annotations_only, buf)
  buf = buf or vim.api.nvim_get_current_buf()
  local s = states[buf]; check(s, 'not an evidence buffer')
  local targets = {}
  if annotations_only then for _, a in ipairs(s.annotations) do targets[#targets + 1] = a.start end
  else targets = { s.data.evidence.start, s.data.evidence['end'] } end
  if #targets == 0 then return end
  local line = vim.api.nvim_win_get_cursor(0)[1]
  local target
  if direction > 0 then for _, n in ipairs(targets) do if n > line then target = n; break end end
  else for i = #targets, 1, -1 do if targets[i] < line then target = targets[i]; break end end end
  target = target or (direction > 0 and targets[1] or targets[#targets])
  vim.api.nvim_win_set_cursor(0, { target, 0 })
end
function M.identity(buf)
  local s = states[buf or vim.api.nvim_get_current_buf()]; check(s, 'not an evidence buffer')
  return identity_text(s)
end
function M.open(file)
  local data = read_private(file)
  local lines, annotations = validate(data) -- Validate fully before touching windows/buffers.
  local buf = vim.api.nvim_create_buf(false, true)
  vim.bo[buf].buftype = 'nofile'; vim.bo[buf].bufhidden = 'wipe'
  vim.bo[buf].swapfile = false; vim.bo[buf].undofile = false; vim.bo[buf].modeline = false
  vim.api.nvim_buf_set_name(buf, 'pi-understanding://' .. data.identity.digest:sub(1, 12) .. '/' .. buf)
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
  vim.bo[buf].modified = false; vim.bo[buf].readonly = true; vim.bo[buf].modifiable = false
  states[buf] = { data = data, annotations = annotations, visible = data.annotationsVisible }
  vim.b[buf].pi_understanding_identity = data.identity
  vim.b[buf].pi_understanding_evidence = { start = data.evidence.start, ['end'] = data.evidence['end'] }
  vim.b[buf].pi_understanding_annotations_visible = data.annotationsVisible
  -- Keep an existing server's active work/draft in its own window; never replace its buffer.
  vim.cmd('botright vnew')
  local empty = vim.api.nvim_get_current_buf()
  vim.api.nvim_win_set_buf(0, buf)
  if vim.api.nvim_buf_is_valid(empty) and vim.api.nvim_buf_get_name(empty) == '' and not vim.bo[empty].modified then vim.api.nvim_buf_delete(empty, { force = false }) end
  vim.wo.number = true; vim.wo.relativenumber = false
  vim.wo.winbar = ('Fixed %s:%s | AI interpretation | ga toggle, ]a/[a chunks, ]e/[e range, gi identity'):format(data.identity.ref, data.identity.path):gsub('%%', '%%%%')
  vim.api.nvim_buf_set_extmark(buf, M.namespaces.range, data.evidence.start - 1, 0, {
    end_row = data.evidence['end'], hl_group = 'Visual', hl_eol = true,
  })
  vim.api.nvim_buf_set_extmark(buf, M.namespaces.identity, 0, 0, {
    virt_lines = { { { ('Fixed source | scope %s | snapshot %s | sha256 %s'):format(data.identity.scope, data.identity.snapshot, data.identity.digest), 'Comment' } } }, virt_lines_above = true,
  })
  local function map(lhs, action, description) vim.keymap.set('n', lhs, action, { buffer = buf, silent = true, desc = description }) end
  map('ga', function() M.toggle(buf) end, 'Toggle AI interpretations')
  map(']a', function() M.navigate(1, true, buf) end, 'Next annotated chunk')
  map('[a', function() M.navigate(-1, true, buf) end, 'Previous annotated chunk')
  map(']e', function() M.navigate(1, false, buf) end, 'Next evidence boundary')
  map('[e', function() M.navigate(-1, false, buf) end, 'Previous evidence boundary')
  map('gi', function() vim.notify(M.identity(buf)) end, 'Full fixed source identity')
  -- readonly alone allows :write! to another filename. Block ordinary write/append commands too.
  -- Deliberately not an OS sandbox: a user can disable autocmds/options or execute arbitrary Lua.
  vim.api.nvim_create_autocmd({ 'BufWriteCmd', 'FileWriteCmd', 'FileAppendCmd' }, {
    buffer = buf, callback = function() fail('fixed evidence buffer cannot be written') end,
  })
  vim.api.nvim_create_autocmd('BufWipeout', { buffer = buf, once = true, callback = function() states[buf] = nil end })
  vim.api.nvim_create_autocmd('VimResized', { buffer = buf, callback = function() render(buf) end })
  render(buf)
  vim.api.nvim_win_set_cursor(0, { data.evidence.start, 0 })
  return buf
end
return M
