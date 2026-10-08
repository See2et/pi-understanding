if vim.g.loaded_pi_understanding then return end
vim.g.loaded_pi_understanding = true
vim.api.nvim_create_user_command('UnderstandingOpen', function(args)
  require('pi_understanding').open(args.args)
end, { nargs = 1, complete = 'file', desc = 'Open a private fixed Pi evidence handoff (no sync)' })
