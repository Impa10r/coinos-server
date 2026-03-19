cp config.ts.sample config.ts
cp compose.yml.sample compose.yml
cp -r sampledata data
sudo chown 100:100 data/nostr/data

# Create the data directory
mkdir -p ./data/tigerbeetle

# Initialize the data file
docker run --rm \
  --privileged \
  -v $(pwd)/data/tigerbeetle:/data \
  ghcr.io/tigerbeetle/tigerbeetle:latest \
  format --cluster=0 --replica=0 --replica-count=1 /data/0_0.tigerbeetle

docker-compose build --no-cache app
docker compose up -d
docker run -it -v $(pwd):/home/bun/app --entrypoint bun asoltys/coinos-server i
docker exec -it bc bitcoin-cli createwallet coinos
docker exec -it bc bitcoin-cli rescanblockchain
docker exec -it bc bitcoin-cli generatetoaddress 500 $(docker exec -it bc bitcoin-cli getnewaddress "" "p2sh-segwit")
docker exec -it lq elements-cli createwallet coinos
