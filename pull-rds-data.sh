#!/bin/bash
# Clone complete database schema and data from AWS RDS to local PostgreSQL

set -e

echo "🔄 Cloning RDS database to local..."
echo ""

# Use the same database settings the deployed app reads from SSM.
AWS_PROFILE="${AWS_PROFILE:-}"
if [ -z "$AWS_PROFILE" ] && [ -f "$HOME/.aws/config" ]; then
  AWS_PROFILE=$(awk -F '[][]' '/^\[profile / { print $2; exit }' "$HOME/.aws/config" | sed 's/^profile //')
fi

fetch_parameter() {
  local args=(
    ssm get-parameter
    --name "$1"
    --with-decryption
    --region us-east-2
    --query Parameter.Value
    --output text
  )
  if [ -n "$AWS_PROFILE" ]; then
    args+=(--profile "$AWS_PROFILE")
  fi
  aws "${args[@]}"
}

DB_HOST=$(fetch_parameter /slugger/db-host)
DB_USERNAME=$(fetch_parameter /slugger/db-username)
DB_PASSWORD=$(fetch_parameter /slugger/db-password)
DB_NAME=$(fetch_parameter /slugger/db-name)
DB_PORT=$(fetch_parameter /slugger/db-port)

# Check if local postgres container is running
if ! docker ps | grep -q slugger-postgres-local; then
    echo "❌ Local postgres container is not running."
    echo "Start it with: npm run db:local:start"
    exit 1
fi

echo "📥 Step 1/3: Dumping RDS..."
docker run --rm -e PGPASSWORD="$DB_PASSWORD" -v /tmp:/dump postgres:15 \
  pg_dump -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USERNAME" -d "$DB_NAME" \
  --no-owner --no-privileges -Fc -f /dump/rds.dump

echo "🗑️  Step 2/3: Resetting local database..."
docker exec -i slugger-postgres-local psql -U postgres -d slugger_local \
  -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" > /dev/null

echo "📤 Step 3/3: Restoring into local Postgres..."
docker cp /tmp/rds.dump slugger-postgres-local:/tmp/rds.dump
docker exec -i slugger-postgres-local pg_restore \
  -U postgres -d slugger_local --no-owner --no-privileges --exit-on-error \
  /tmp/rds.dump

echo "🧹 Cleaning up..."
rm -f /tmp/rds.dump
docker exec -i slugger-postgres-local rm -f /tmp/rds.dump

echo ""
echo "✅ Clone complete!"
echo ""
echo "📊 Verify data:"
echo "  docker exec -it slugger-postgres-local psql -U postgres -d slugger_local -c '\\dt'"
echo "  docker exec -it slugger-postgres-local psql -U postgres -d slugger_local -c 'SELECT COUNT(*) FROM users;'"
