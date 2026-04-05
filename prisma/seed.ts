import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding database...');

  // Clear existing data
  await prisma.activity.deleteMany();
  await prisma.comment.deleteMany();
  await prisma.registration.deleteMany();
  await prisma.event.deleteMany();
  await prisma.user.deleteMany();

  // Create users: 1 admin, 2 members
  const adminHash = await bcrypt.hash('admin123', 10);
  const member1Hash = await bcrypt.hash('member123', 10);
  const member2Hash = await bcrypt.hash('member456', 10);

  const admin = await prisma.user.create({
    data: { email: 'admin@example.com', name: 'Admin User', passwordHash: adminHash, role: 'admin' },
  });

  const member1 = await prisma.user.create({
    data: { email: 'alice@example.com', name: 'Alice Smith', passwordHash: member1Hash, role: 'member' },
  });

  const member2 = await prisma.user.create({
    data: { email: 'bob@example.com', name: 'Bob Jones', passwordHash: member2Hash, role: 'member' },
  });

  console.log('Created users:', admin.email, member1.email, member2.email);

  // Create 5 events
  const event1 = await prisma.event.create({
    data: {
      title: 'Tech Conference 2025',
      description: 'Annual technology conference covering AI, cloud, and more.',
      date: new Date('2025-06-15T09:00:00Z'),
      location: 'San Francisco, CA',
      capacity: 100,
      status: 'published',
      organizerId: admin.id,
    },
  });

  const event2 = await prisma.event.create({
    data: {
      title: 'JavaScript Workshop',
      description: 'Hands-on workshop covering modern JavaScript and TypeScript.',
      date: new Date('2025-07-20T14:00:00Z'),
      location: 'New York, NY',
      capacity: 30,
      status: 'published',
      organizerId: member1.id,
    },
  });

  const event3 = await prisma.event.create({
    data: {
      title: 'Web Design Meetup',
      description: 'Monthly meetup for web designers and UX professionals.',
      date: new Date('2025-05-10T18:00:00Z'),
      location: 'Austin, TX',
      capacity: 50,
      status: 'published',
      organizerId: member2.id,
    },
  });

  const event4 = await prisma.event.create({
    data: {
      title: 'DevOps Summit',
      description: 'Deep dive into CI/CD, containers, and infrastructure as code.',
      date: new Date('2025-08-05T10:00:00Z'),
      location: 'Seattle, WA',
      capacity: 200,
      status: 'draft',
      organizerId: admin.id,
    },
  });

  const event5 = await prisma.event.create({
    data: {
      title: 'Security Workshop',
      description: 'Practical security workshop covering OWASP top 10.',
      date: new Date('2025-09-12T09:00:00Z'),
      location: 'Chicago, IL',
      capacity: 40,
      status: 'published',
      organizerId: admin.id,
    },
  });

  console.log('Created events:', event1.title, event2.title, event3.title, event4.title, event5.title);

  // Create 10 registrations
  const reg1 = await prisma.registration.create({
    data: { eventId: event1.id, userId: member1.id, status: 'confirmed' },
  });

  const reg2 = await prisma.registration.create({
    data: { eventId: event1.id, userId: member2.id, status: 'confirmed' },
  });

  const reg3 = await prisma.registration.create({
    data: { eventId: event2.id, userId: admin.id, status: 'confirmed' },
  });

  const reg4 = await prisma.registration.create({
    data: { eventId: event2.id, userId: member2.id, status: 'confirmed' },
  });

  const reg5 = await prisma.registration.create({
    data: { eventId: event3.id, userId: member1.id, status: 'confirmed' },
  });

  const reg6 = await prisma.registration.create({
    data: { eventId: event3.id, userId: admin.id, status: 'confirmed' },
  });

  const reg7 = await prisma.registration.create({
    data: { eventId: event5.id, userId: member1.id, status: 'confirmed' },
  });

  const reg8 = await prisma.registration.create({
    data: { eventId: event5.id, userId: member2.id, status: 'confirmed' },
  });

  const reg9 = await prisma.registration.create({
    data: { eventId: event1.id, userId: admin.id, status: 'waitlisted' },
  });

  const reg10 = await prisma.registration.create({
    data: { eventId: event3.id, userId: member2.id, status: 'waitlisted' },
  });

  console.log('Created 10 registrations');

  // Create 5 comments
  const comment1 = await prisma.comment.create({
    data: { content: 'Looking forward to this event!', eventId: event1.id, authorId: member1.id },
  });

  const comment2 = await prisma.comment.create({
    data: { content: 'Will there be recordings available?', eventId: event1.id, authorId: member2.id },
  });

  const comment3 = await prisma.comment.create({
    data: { content: 'Great workshop last time, excited for this one!', eventId: event2.id, authorId: admin.id },
  });

  const comment4 = await prisma.comment.create({
    data: { content: 'Is there parking available at the venue?', eventId: event3.id, authorId: member1.id },
  });

  const comment5 = await prisma.comment.create({
    data: { content: 'Please cover OWASP A01 in detail!', eventId: event5.id, authorId: member2.id },
  });

  console.log('Created 5 comments');

  // Create activities
  await prisma.activity.createMany({
    data: [
      { eventId: event1.id, userId: member1.id, action: 'registered', metadata: JSON.stringify({ registrationId: reg1.id }) },
      { eventId: event1.id, userId: member2.id, action: 'registered', metadata: JSON.stringify({ registrationId: reg2.id }) },
      { eventId: event2.id, userId: admin.id, action: 'registered', metadata: JSON.stringify({ registrationId: reg3.id }) },
      { eventId: event2.id, userId: member2.id, action: 'registered', metadata: JSON.stringify({ registrationId: reg4.id }) },
      { eventId: event3.id, userId: member1.id, action: 'registered', metadata: JSON.stringify({ registrationId: reg5.id }) },
      { eventId: event1.id, userId: member1.id, action: 'commented', metadata: JSON.stringify({ commentId: comment1.id }) },
      { eventId: event1.id, userId: member2.id, action: 'commented', metadata: JSON.stringify({ commentId: comment2.id }) },
      { eventId: event2.id, userId: admin.id, action: 'commented', metadata: JSON.stringify({ commentId: comment3.id }) },
      { eventId: event1.id, userId: admin.id, action: 'waitlisted', metadata: JSON.stringify({ registrationId: reg9.id }) },
      { eventId: event1.id, userId: admin.id, action: 'status_changed', metadata: JSON.stringify({ from: 'draft', to: 'published' }) },
    ],
  });

  console.log('Created activities');
  console.log('Seeding complete!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
