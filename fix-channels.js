const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function fixChannels() {
  try {
    console.log('🔧 Исправляем каналы...');
    
    // Находим первого пользователя (админа)
    const admin = await prisma.user.findFirst({
      where: {
        OR: [
          { username: 'admin' },
          { id: 1 }
        ]
      }
    });
    
    if (!admin) {
      console.log('❌ Админ не найден, берем первого пользователя');
      const firstUser = await prisma.user.findFirst();
      if (!firstUser) {
        console.log('❌ Нет пользователей в базе!');
        return;
      }
      admin = firstUser;
    }
    
    console.log(`👤 Используем пользователя: ${admin.username} (id: ${admin.id})`);
    
    // Находим все каналы
    const channels = await prisma.channel.findMany();
    console.log(`📢 Всего каналов: ${channels.length}`);
    
    for (const channel of channels) {
      console.log(`\n📢 Канал: "${channel.name}" (id: ${channel.id})`);
      console.log(`   creatorId: ${channel.creatorId}`);
      
      // Если creatorId отсутствует или равен null
      if (!channel.creatorId) {
        console.log(`   ⚠️ Нет creatorId, устанавливаем ${admin.id}`);
        
        await prisma.channel.update({
          where: { id: channel.id },
          data: { creatorId: admin.id }
        });
        
        // Проверяем, есть ли создатель в участниках
        const member = await prisma.channelMember.findFirst({
          where: {
            channelId: channel.id,
            userId: admin.id
          }
        });
        
        if (!member) {
          console.log(`   ➕ Добавляем админа в участники канала`);
          await prisma.channelMember.create({
            data: {
              channelId: channel.id,
              userId: admin.id,
              role: 'admin'
            }
          });
        } else {
          console.log(`   ✅ Админ уже участник канала`);
        }
        
        console.log(`   ✅ Канал исправлен`);
      } else {
        console.log(`   ✅ creatorId уже есть: ${channel.creatorId}`);
      }
    }
    
    console.log('\n✅ Все каналы проверены и исправлены!');
    
  } catch (error) {
    console.error('❌ Ошибка:', error);
  } finally {
    await prisma.$disconnect();
  }
}

fixChannels();