const { Schema, model } = require('mongoose');

const cardSchema = new Schema(
  {
    title: { type: String, trim: true, default: '' },
    body: { type: String, trim: true, default: '' },
  },
  { _id: false }
);

const skillGroupSchema = new Schema(
  {
    title: { type: String, trim: true, default: '' },
    items: [{ type: String, trim: true }],
  },
  { _id: false }
);

const projectSchema = new Schema(
  {
    title: { type: String, trim: true, default: '' },
    description: { type: String, trim: true, default: '' },
    tags: [{ type: String, trim: true }],
  },
  { _id: false }
);

const experienceSchema = new Schema(
  {
    role: { type: String, trim: true, default: '' },
    company: { type: String, trim: true, default: '' },
    location: { type: String, trim: true, default: '' },
    period: { type: String, trim: true, default: '' },
    bullets: [{ type: String, trim: true }],
  },
  { _id: false }
);

const educationSchema = new Schema(
  {
    title: { type: String, trim: true, default: '' },
    field: { type: String, trim: true, default: '' },
    org: { type: String, trim: true, default: '' },
    result: { type: String, trim: true, default: '' },
    period: { type: String, trim: true, default: '' },
    board: { type: String, trim: true, default: '' },
  },
  { _id: false }
);

const blogPostSchema = new Schema(
  {
    title: { type: String, trim: true, default: '' },
    excerpt: { type: String, trim: true, default: '' },
    date: { type: String, trim: true, default: '' },
    tags: [{ type: String, trim: true }],
    readTime: { type: String, trim: true, default: '' },
    link: { type: String, trim: true, default: '' },
  },
  { _id: false }
);

const portfolioSchema = new Schema(
  {
    profile: {
      name: { type: String, trim: true, default: 'Md Ikram' },
      alternateNames: [{ type: String, trim: true }],
      jobTitle: { type: String, trim: true, default: 'Senior Software Developer' },
      tagline: { type: String, trim: true, default: '' },
      avatarUrl: { type: String, trim: true, default: '/assets/images/portfolio-pp.png' },
      cvUrl: { type: String, trim: true, default: '/assets/cv.pdf' },
      email: { type: String, trim: true, default: '' },
      phone: { type: String, trim: true, default: '' },
      website: { type: String, trim: true, default: '' },
      addressLine1: { type: String, trim: true, default: '' },
      addressLine2: { type: String, trim: true, default: '' },
      locality: { type: String, trim: true, default: '' },
      country: { type: String, trim: true, default: '' },
      dateOfBirth: { type: String, trim: true, default: '' },
      religion: { type: String, trim: true, default: '' },
      nationality: { type: String, trim: true, default: '' },
      hobbies: { type: String, trim: true, default: '' },
      languages: { type: String, trim: true, default: '' },
    },
    social: {
      facebook: { type: String, trim: true, default: '' },
      linkedin: { type: String, trim: true, default: '' },
      github: { type: String, trim: true, default: '' },
      twitter: { type: String, trim: true, default: '' },
    },
    hero: {
      eyebrow: { type: String, trim: true, default: 'Available for work' },
      titlePrefix: { type: String, trim: true, default: "Hi, I'm" },
      highlightedName: { type: String, trim: true, default: 'Md Ikram' },
      description: { type: String, trim: true, default: '' },
    },
    homeAbout: {
      title: { type: String, trim: true, default: 'About' },
      subtitle: { type: String, trim: true, default: '' },
      cards: [cardSchema],
    },
    skills: {
      title: { type: String, trim: true, default: 'Technical Skills' },
      subtitle: { type: String, trim: true, default: '' },
      groups: [skillGroupSchema],
    },
    projects: {
      title: { type: String, trim: true, default: 'Projects' },
      subtitle: { type: String, trim: true, default: '' },
      items: [projectSchema],
    },
    homeExperience: {
      title: { type: String, trim: true, default: 'Work Experience' },
      subtitle: { type: String, trim: true, default: '' },
    },
    homeContact: {
      title: { type: String, trim: true, default: 'Contact' },
      subtitle: { type: String, trim: true, default: '' },
    },
    aboutPage: {
      title: { type: String, trim: true, default: 'About Me' },
      subtitle: { type: String, trim: true, default: '' },
      careerObjectives: { type: String, trim: true, default: '' },
      strengths: [{ type: String, trim: true }],
    },
    resumePage: {
      title: { type: String, trim: true, default: 'Resume' },
      subtitle: { type: String, trim: true, default: '' },
    },
    experiences: [experienceSchema],
    education: [educationSchema],
    blogs: {
      title: { type: String, trim: true, default: 'Blog' },
      subtitle: { type: String, trim: true, default: '' },
      posts: [blogPostSchema],
    },
    contactPage: {
      title: { type: String, trim: true, default: 'Contact' },
      subtitle: { type: String, trim: true, default: '' },
      mailSubjectPrefix: {
        type: String,
        trim: true,
        default: 'New message from Connect Portfolio',
      },
    },
    seo: {
      keywords: { type: String, trim: true, default: '' },
      homeTitle: { type: String, trim: true, default: '' },
      homeDescription: { type: String, trim: true, default: '' },
    },
    footerText: { type: String, trim: true, default: '' },
  },
  { timestamps: true }
);

module.exports = model('Portfolio', portfolioSchema);
