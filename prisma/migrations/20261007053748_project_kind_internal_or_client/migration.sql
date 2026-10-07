-- CreateEnum
CREATE TYPE "ProjectKind" AS ENUM ('CLIENT', 'INTERNAL');

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "kind" "ProjectKind" NOT NULL DEFAULT 'CLIENT',
ALTER COLUMN "clientId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "Project_kind_status_idx" ON "Project"("kind", "status");
