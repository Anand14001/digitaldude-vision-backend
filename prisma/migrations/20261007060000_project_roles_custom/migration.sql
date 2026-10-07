-- Replace the fixed member role with admin-definable project roles.
-- Who leads a project is kept: the old LEAD value becomes the isLead flag.

ALTER TABLE "ProjectMember" ADD COLUMN "isLead" BOOLEAN NOT NULL DEFAULT false;
UPDATE "ProjectMember" SET "isLead" = true WHERE "role"::text = 'LEAD';
ALTER TABLE "ProjectMember" DROP COLUMN "role";

-- DropEnum
DROP TYPE "ProjectRole";

-- CreateTable
CREATE TABLE "ProjectRole" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "color" TEXT NOT NULL DEFAULT '#64748b',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectMemberRole" (
    "projectMemberId" TEXT NOT NULL,
    "projectRoleId" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectMemberRole_pkey" PRIMARY KEY ("projectMemberId","projectRoleId")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProjectRole_name_key" ON "ProjectRole"("name");

-- CreateIndex
CREATE INDEX "ProjectMemberRole_projectRoleId_idx" ON "ProjectMemberRole"("projectRoleId");

-- CreateIndex
CREATE INDEX "ProjectMember_projectId_isLead_idx" ON "ProjectMember"("projectId", "isLead");

-- AddForeignKey
ALTER TABLE "ProjectMemberRole" ADD CONSTRAINT "ProjectMemberRole_projectMemberId_fkey" FOREIGN KEY ("projectMemberId") REFERENCES "ProjectMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectMemberRole" ADD CONSTRAINT "ProjectMemberRole_projectRoleId_fkey" FOREIGN KEY ("projectRoleId") REFERENCES "ProjectRole"("id") ON DELETE CASCADE ON UPDATE CASCADE;
