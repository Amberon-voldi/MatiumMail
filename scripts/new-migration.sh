#!/bin/sh
# Create a new Prisma migration WITHOUT a database, by diffing the committed
# schema (git HEAD) against the working-copy schema.
#   npm run db:migration:new -- <name>
# Then review the SQL and apply it with: npm run db:migrate:remote
set -eu
NAME="${1:?usage: npm run db:migration:new -- <name>}"
DIR="prisma/migrations/$(date -u +%Y%m%d%H%M%S)_${NAME}"
PREV="$(mktemp)"
trap 'rm -f "$PREV"' EXIT
git show HEAD:prisma/schema.prisma > "$PREV"
mkdir -p "$DIR"
# The schema engine requires a datasource URL to be set; it is never contacted for a schema→schema diff.
DATABASE_URL="mysql://offline:offline@127.0.0.1:1/offline" \
  npx prisma migrate diff --from-schema "$PREV" --to-schema prisma/schema.prisma --script > "$DIR/migration.sql"
if [ ! -s "$DIR/migration.sql" ] || ! grep -qv '^--' "$DIR/migration.sql"; then
  rm -rf "$DIR"; echo "No schema changes since HEAD."; exit 0
fi
echo "Created $DIR/migration.sql:"; cat "$DIR/migration.sql"
