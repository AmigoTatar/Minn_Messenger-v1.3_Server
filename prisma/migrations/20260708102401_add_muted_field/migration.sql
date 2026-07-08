-- AlterTable
ALTER TABLE "ChannelMember" ADD COLUMN "muted" BOOLEAN DEFAULT false;

-- AlterTable
ALTER TABLE "ChatMember" ADD COLUMN "muted" BOOLEAN DEFAULT false;

-- AlterTable
ALTER TABLE "PrivateChatMember" ADD COLUMN "muted" BOOLEAN DEFAULT false;
