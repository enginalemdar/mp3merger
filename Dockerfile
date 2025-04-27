# Resmi Node.js lightweight imajını temel al
# slim versiyonları daha küçüktür ve genellikle yeterlidir.
# Kullanmak istediğiniz Node.js versiyonunu seçebilirsiniz, örneğin 20-slim veya lts-slim
FROM node:20-slim

# Uygulama dosyalarımızı koyacağımız çalışma dizinini belirle
WORKDIR /app

# package.json ve package-lock.json (varsa) dosyalarını kopyala
# Bu adım, bağımlılıkların önbelleğe alınmasını optimize eder.
COPY package*.json ./

# Node.js bağımlılıklarını kur
# Bu komut package.json dosyasındaki bağımlılıkları WORKDIR'e kurar
RUN npm install

# FFmpeg'i kur
# Önce paket listelerini güncelle, sonra ffmpeg paketini kur (-y ile onayı otomatik yap)
# Ardından apt önbelleğini temizleyerek imaj boyutunu küçült
RUN apt-get update && apt-get install -y ffmpeg --no-install-recommends && rm -rf /var/lib/apt/lists/*

# Geri kalan uygulama dosyalarını kopyala
# server.js ve diğer dosyaları WORKDIR'e kopyalar
COPY . .

# Uygulamanın dinleyeceği portu dışarıya aç
# server.js dosyasındaki port ile eşleşmeli (varsayılan 3000)
EXPOSE 3000

# Container başladığında çalıştırılacak komutu tanımla
# Bu komut Node.js sunucumuzu başlatır
CMD [ "node", "server.js" ]
