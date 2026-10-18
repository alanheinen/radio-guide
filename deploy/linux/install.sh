#!/bin/sh
# Install Signal Radio as a systemd service, or remove it.
#
#   sudo deploy/linux/install.sh              install or update, then (re)start
#   sudo deploy/linux/install.sh --uninstall  stop and remove everything
#
# Copies the app to $PREFIX (default /opt/signal-radio), installs
# signal-radio.service, and writes /etc/signal-radio.env on first install only, so
# your settings survive updates. Needs Python 3.9+ and systemd; nothing else.
set -eu

PREFIX=${PREFIX:-/opt/signal-radio}
UNIT=/etc/systemd/system/signal-radio.service
ENVFILE=/etc/signal-radio.env
SRC=$(cd "$(dirname "$0")/../.." && pwd)

die() { echo "install.sh: $*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "run as root (sudo $0)"
command -v systemctl >/dev/null || die "systemd is required"

if [ "${1:-}" = "--uninstall" ]; then
    systemctl disable --now signal-radio.service 2>/dev/null || true
    rm -f "$UNIT"
    systemctl daemon-reload
    rm -rf "$PREFIX" /var/lib/private/signal-radio /var/lib/signal-radio
    echo "Removed signal-radio. $ENVFILE is kept; delete it if you don't need your settings."
    exit 0
fi
[ $# -eq 0 ] || die "unknown option: $1 (use --uninstall or nothing)"

PYTHON=$(command -v python3 || true)
[ -n "$PYTHON" ] || die "python3 not found; install Python 3.9 or newer"
"$PYTHON" -c 'import sys; sys.exit(sys.version_info < (3, 9))' \
    || die "$PYTHON is $("$PYTHON" -V 2>&1); Python 3.9 or newer is needed"
[ -f "$SRC/scripts/serve.py" ] || die "run this from a copy of the repository ($SRC has no scripts/serve.py)"

# Fresh copy each time, so files removed upstream don't linger.
rm -rf "$PREFIX.new"
mkdir -p "$PREFIX.new/web"
cp -R "$SRC/scripts" "$PREFIX.new/"
cp "$SRC/web/index.html" "$SRC/web/app.css" "$SRC/web/app.js" "$SRC/web/receiver.html" "$SRC/web/receiver.js" "$PREFIX.new/web/"
rm -rf "$PREFIX.new/scripts/__pycache__"
rm -rf "$PREFIX"
mv "$PREFIX.new" "$PREFIX"
chmod -R a+rX,go-w "$PREFIX"

sed -e "s|@PYTHON@|$PYTHON|g" -e "s|@PREFIX@|$PREFIX|g" "$SRC/deploy/linux/signal-radio.service" > "$UNIT"

if [ ! -e "$ENVFILE" ]; then
    cat > "$ENVFILE" <<'EOF'
# Signal Radio settings. Restart after editing:
#   sudo systemctl restart signal-radio
#
# Countries to build, as ISO codes, e.g. us,ca,gb.
COUNTRIES=us
# 127.0.0.1 serves this machine only. Use 0.0.0.0 to listen from other devices
# on your network, but never expose it to the internet: the stream proxy
# would become an open relay.
HOST=127.0.0.1
PORT=8080
EOF
fi

systemctl daemon-reload
systemctl enable signal-radio.service >/dev/null 2>&1
systemctl restart signal-radio.service

. "$ENVFILE"
case "${HOST:-127.0.0.1}" in 0.0.0.0|::) where=$(hostname) ;; *) where=${HOST:-127.0.0.1} ;; esac
echo "signal-radio is running. The first build takes under a minute; then open"
echo "  http://$where:${PORT:-8080}/"
echo "Settings: $ENVFILE   Logs: journalctl -u signal-radio"
