cp config.ts.sample config.ts
cp compose.yml.sample compose.yml
cp -r sampledata data
sudo chown 100:100 data/nostr/data

# create network
docker network create net 

# Create the data directory
mkdir -p ./data/tigerbeetle

# Initialize the data file
docker run --rm \
  --privileged \
  -v $(pwd)/data/tigerbeetle:/data \
  ghcr.io/tigerbeetle/tigerbeetle:latest \
  format --cluster=0 --replica=0 --replica-count=1 /data/0_0.tigerbeetle

# init ark
SEED=$(curl -s http://localhost:7071/v1/admin/wallet/seed | grep -o '"seed":"[^"]*"' | cut -d'"' -f4)
curl -X POST http://localhost:7071/v1/admin/wallet/create \
  -H 'Content-Type: application/json' \
  -d "{\"password\":\"testpassword\",\"seed\":\"$SEED\"}"
curl -X POST http://localhost:7071/v1/admin/wallet/unlock \
  -H 'Content-Type: application/json' \
  -d '{"password":"testpassword"}'
  
docker-compose build --no-cache app
docker compose up -d
docker run -it -v $(pwd):/home/bun/app --entrypoint bun asoltys/coinos-server i
docker exec -it bc bitcoin-cli createwallet coinos
docker exec -it bc bitcoin-cli rescanblockchain
docker exec -it bc bitcoin-cli generatetoaddress 500 $(docker exec -it bc bitcoin-cli getnewaddress "" "p2sh-segwit")
docker exec -it lq elements-cli createwallet coinos
