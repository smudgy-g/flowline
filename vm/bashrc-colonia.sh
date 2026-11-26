# The laptop's colonia aliases, pointed at the VM's own tree (vm/bootstrap.sh installs this as ~/.bashrc.d/colonia.sh).
export EDITOR=nvim
alias wx=workmux lz=lazygit nv=nvim
alias wx-start='cd /home/smudgee/Projects/colonia/client/staging && tmux new-session -A -s colonia'
alias fx='pnpm --dir /home/smudgee/Projects/colonia/frankenstein/mastra -s fx'
alias fx-new='cd /home/smudgee/Projects/colonia/frankenstein && pi'
alias cd-staging='cd /home/smudgee/Projects/colonia/client/staging'
alias cd-db='cd /home/smudgee/Projects/colonia/supabase/staging'
