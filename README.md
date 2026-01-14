# 🤖 BotRanked – Discord Bot avec Docker & PostgreSQL

Bot Discord développé en **Node.js**, conteneurisé avec **Docker** et utilisant **PostgreSQL** comme base de données.

---

## 🔐 Données sensibles

⚠️ Aucune donnée sensible ne doit être commitée sur GitHub.  
Le fichier `.env` contient :
- le token Discord
- les identifiants PostgreSQL

👉 Assure-toi qu’il est bien présent dans le `.gitignore`.

---

## ✅ Pré-requis

### Docker
https://docs.docker.com/engine/install/ubuntu/

### PostgreSQL
https://doc.ubuntu-fr.org/postgresql

### Création d’un bot Discord (Node.js)
https://www.dropvps.com/blog/build-discord-bot-on-ubuntu-25-04/

---

## 📦 Installation

```bash
mkdir -p /var/www/bot-discord/BotRanked
cd /var/www/bot-discord/BotRanked
```

### Arborescence du projet 
BotRanked/
├── src/                 # Code du bot Discord
├── package.json
├── requirements.txt
├── Dockerfile
├── docker-compose.yml
├── .env                 # ❌ Ne pas commit
└── README.md


### ⚙️ Configuration 

.env : 
```
PORT=3000
NODE_ENV=production

DATABASE_URL=postgres://[USERBOT]:[PWSD]@postgres:5432/[USERDB]
BOT_TOKEN=[TOKENBOTDISCORD]
```

docker-compose.yml
```
services:
	  postgres:
		image: postgres:16
		container_name: bot-postgres
		restart: unless-stopped
		environment:
		  POSTGRES_DB: [USERDB]
		  POSTGRES_USER: [USERBOT]
		  POSTGRES_PASSWORD: [MDPBD]
		volumes:
		  - postgres_data:/var/lib/postgresql/data

	  discord-bot:
		build: .
		container_name: discord-bot
		restart: unless-stopped
		env_file:
		  - .env
		depends_on:
		  - postgres

	volumes:
	  postgres_data:
```

Dockerfile : 
```
	FROM node:20-alpine
	WORKDIR /app
	COPY package*.json ./
	RUN npm ci --omit=dev
	COPY . .
	CMD ["npm", "start"]
```

.gitignore : 
```
	node_modules/
	.env
	.env.local
	dist/
	*.log
	.DS_Store
	.env.env
```

## ▶️ Lancement du bot

```Bash
cd /var/www/bot-discord/BotRanked
docker compose up -d --build
```

## 📊 Vérification 

```bash
docker compose ps
```

### Resultat attendu
```bash
  bot-postgres   postgres:16    postgres   5432/tcp
	discord-bot    botranked-discord-bot  discord-bot  
```


### Log du bot 
```bash
docker compose logs -f discord-bot
```


## 🛠️ Commande utiles :

Redemarrer le bot :
```bash
docker compose restart discord-bot
```

Arret du containers :
```bash
docker compose down
```

Supprimer la base de données : 
```bash
docker compose down -v
```

