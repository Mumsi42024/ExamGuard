'use strict';

import mongoose from 'mongoose';

const TimetableSchema = new mongoose.Schema({
  studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', default: null },
  students: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Student' }], // allow per-class entries
  day: String,  
  start: String, 
  end: String,   
  subject: String,
  location: String,
  teacher: String,
  meta: mongoose.Schema.Types.Mixed
}, { timestamps: true });

const Timetable = mongoose.models.Timetable || mongoose.model('Timetable', TimetableSchema);
export default Timetable;
