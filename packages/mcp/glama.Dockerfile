# For Glama's automated checks (paste into the server's admin page on glama.ai).
# Starts the published npm package over stdio. The default vault is the public
# demo vault and there is no agent key, so the server can list tools and read
# the vault, but it cannot pay anything. Real users set their own vault + key.
FROM node:22.20.0-alpine
RUN npm install -g @zaxcoraider/agentguard-mcp@0.1.2 --ignore-scripts
ENV NEAR_NETWORK=testnet \
    AGENTGUARD_VAULT=demo2.agentguard.testnet
CMD ["agentguard-mcp"]
